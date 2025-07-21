package queue

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea/v2"
	"github.com/sst/opencode-sdk-go"
	"github.com/sst/opencode/internal/id"
)

type QueuedMessage struct {
	ID           string
	Text         string
	Attachments  []opencode.FilePartInputParam
	Timestamp    time.Time
	Consolidated bool
}

type App interface {
	IsBusy() bool
	SendChatMessage(ctx context.Context, text string, attachments []opencode.FilePartInputParam) (interface{}, tea.Cmd)
}

type Manager struct {
	mu          sync.RWMutex
	queue       []QueuedMessage
	app         App
	consolidate bool
	lastEnqueue time.Time
}

func NewManager(app App) *Manager {
	return &Manager{
		app:         app,
		queue:       make([]QueuedMessage, 0),
		consolidate: true,
		lastEnqueue: time.Now(),
	}
}

func (m *Manager) Enqueue(text string, attachments []opencode.FilePartInputParam) {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()

	if m.consolidate && len(m.queue) > 0 && now.Sub(m.lastEnqueue) < 500*time.Millisecond {
		// Consolidate with last message
		last := &m.queue[len(m.queue)-1]
		last.Text = m.consolidateMessages(last.Text, text)
		last.Attachments = append(last.Attachments, attachments...)
		last.Consolidated = true
		m.lastEnqueue = now
		slog.Debug("consolidated message", "queue_length", len(m.queue))
		return
	}

	msg := QueuedMessage{
		ID:           id.Ascending(id.Message),
		Text:         text,
		Attachments:  attachments,
		Timestamp:    now,
		Consolidated: false,
	}

	m.queue = append(m.queue, msg)
	m.lastEnqueue = now
	slog.Debug("enqueued message", "queue_length", len(m.queue))
}

func (m *Manager) Dequeue() *QueuedMessage {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(m.queue) == 0 {
		return nil
	}

	msg := m.queue[0]
	m.queue = m.queue[1:]
	slog.Debug("dequeued message", "queue_length", len(m.queue))
	return &msg
}

func (m *Manager) Flush() []QueuedMessage {
	m.mu.Lock()
	defer m.mu.Unlock()

	messages := make([]QueuedMessage, len(m.queue))
	copy(messages, m.queue)
	m.queue = m.queue[:0]
	slog.Debug("flushed queue", "count", len(messages))
	return messages
}

func (m *Manager) Length() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.queue)
}

func (m *Manager) IsEmpty() bool {
	return m.Length() == 0
}

func (m *Manager) ShouldInject() bool {
	if m.IsEmpty() {
		return false
	}

	// Always allow injection if we have messages
	return true
}

func (m *Manager) ProcessQueue(ctx context.Context) tea.Cmd {
	if !m.ShouldInject() {
		return nil
	}

	msg := m.Dequeue()
	if msg == nil {
		return nil
	}

	_, cmd := m.app.SendChatMessage(ctx, msg.Text, msg.Attachments)
	return cmd
}

func (m *Manager) ProcessQueueWithInjection(ctx context.Context) tea.Cmd {
	if !m.ShouldInject() {
		return nil
	}

	// If app is not busy, process immediately
	if !m.app.IsBusy() {
		msg := m.Dequeue()
		if msg == nil {
			return nil
		}

		_, cmd := m.app.SendChatMessage(ctx, msg.Text, msg.Attachments)
		return cmd
	}

	// When busy, we'll let the injection manager handle timing
	// This allows injection during tool execution
	msg := m.Dequeue()
	if msg == nil {
		return nil
	}

	_, cmd := m.app.SendChatMessage(ctx, msg.Text, msg.Attachments)
	return cmd
}

func (m *Manager) ProcessAll(ctx context.Context) tea.Cmd {
	var cmds []tea.Cmd
	for !m.IsEmpty() {
		cmd := m.ProcessQueueWithInjection(ctx)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
	}
	return tea.Batch(cmds...)
}

func (m *Manager) consolidateMessages(existing, newText string) string {
	if existing == "" {
		return newText
	}

	// Enhanced consolidation: detect similar topics and merge intelligently
	newLower := strings.ToLower(newText)

	// If both are short commands or questions, merge them
	if len(existing) < 100 && len(newText) < 100 {
		return existing + " | " + newText
	}

	// If new text is a continuation (starts with conjunction)
	if strings.HasPrefix(strings.TrimSpace(newLower), "and") ||
		strings.HasPrefix(strings.TrimSpace(newLower), "also") ||
		strings.HasPrefix(strings.TrimSpace(newLower), "then") ||
		strings.HasPrefix(strings.TrimSpace(newLower), "but") {
		return existing + " " + newText
	}
	// Default consolidation
	return existing + "\n\n[Follow-up] " + newText
}

func (m *Manager) GetQueueInfo() (int, time.Duration) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if len(m.queue) == 0 {
		return 0, 0
	}

	oldest := m.queue[0].Timestamp
	return len(m.queue), time.Since(oldest)
}

func (m *Manager) GetQueuedMessages() []QueuedMessage {
	m.mu.RLock()
	defer m.mu.RUnlock()

	messages := make([]QueuedMessage, len(m.queue))
	copy(messages, m.queue)
	return messages
}
