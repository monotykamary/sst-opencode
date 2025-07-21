package app

import (
	"context"

	tea "github.com/charmbracelet/bubbletea/v2"
	"github.com/sst/opencode-sdk-go"
)

type queueAdapter struct {
	app *App
}

func (qa *queueAdapter) IsBusy() bool {
	return qa.app.IsBusy()
}

func (qa *queueAdapter) SendChatMessage(ctx context.Context, text string, attachments []opencode.FilePartInputParam) (interface{}, tea.Cmd) {
	return qa.app.SendChatMessage(ctx, text, attachments)
}
