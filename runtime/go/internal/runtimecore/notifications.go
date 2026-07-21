package runtimecore

import (
	"errors"
	"strings"
)

type NotificationEvent struct {
	Type           string `json:"type"`
	Source         string `json:"source,omitempty"`
	Title          string `json:"title,omitempty"`
	Body           string `json:"body,omitempty"`
	WorktreeID     string `json:"worktreeId,omitempty"`
	NotificationID string `json:"notificationId,omitempty"`
}

func (m *Manager) PublishNotification(event NotificationEvent) error {
	event.Type = strings.TrimSpace(event.Type)
	if event.Type != "notification" && event.Type != "dismiss" {
		return errors.New("notification event type is invalid")
	}
	if event.Type == "notification" {
		if strings.TrimSpace(event.Title) == "" || strings.TrimSpace(event.Body) == "" {
			return errors.New("notification title and body are required")
		}
	} else if strings.TrimSpace(event.NotificationID) == "" {
		return errors.New("notification id is required")
	}
	m.emit("notification.dispatched", event)
	return nil
}
