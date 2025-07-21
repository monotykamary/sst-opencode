package queue

import (
	"context"
	"log/slog"

	tea "github.com/charmbracelet/bubbletea/v2"
	"github.com/sst/opencode-sdk-go"
)

type InjectionManager struct {
	queue   *Manager
	context context.Context
}

func NewInjectionManager(queue *Manager, ctx context.Context) *InjectionManager {
	return &InjectionManager{
		queue:   queue,
		context: ctx,
	}
}

func (im *InjectionManager) HandleEvent(msg tea.Msg) tea.Cmd {
	switch msg := msg.(type) {
	case opencode.EventListResponseEventMessagePartUpdated:
		return im.handlePartUpdate(msg)
	case opencode.EventListResponseEventMessageUpdated:
		return im.handleMessageUpdate(msg)
	default:
		return nil
	}
}

func (im *InjectionManager) handlePartUpdate(msg opencode.EventListResponseEventMessagePartUpdated) tea.Cmd {
	// Part updates don't trigger injection - only message completion does
	return nil
}

func (im *InjectionManager) handleMessageUpdate(msg opencode.EventListResponseEventMessageUpdated) tea.Cmd {
	info := msg.Properties.Info

	// Check if this is an assistant message
	if info.Role == "assistant" {
		assistant, ok := info.AsUnion().(opencode.AssistantMessage)
		if !ok {
			return nil
		}

		// Only inject when message is fully complete (not during streaming)
		if assistant.Time.Completed > 0 {
			slog.Debug("assistant message completed, processing queue")
			return im.queue.ProcessQueueWithInjection(im.context)
		}
	}

	return nil
}

func (im *InjectionManager) CheckIdleInjection() tea.Cmd {
	// Only inject when app is not busy and queue has messages
	if im.queue.ShouldInject() && !im.queue.app.IsBusy() {
		slog.Debug("idle injection triggered - app is not busy")
		return im.queue.ProcessQueueWithInjection(im.context)
	}
	return nil
}
