package runtimecore

import (
	"errors"
	"sort"
	"strings"
	"time"
)

type RuntimeSettingScope string

const (
	RuntimeSettingGlobal    RuntimeSettingScope = "global"
	RuntimeSettingProject   RuntimeSettingScope = "project"
	RuntimeSettingWorkspace RuntimeSettingScope = "workspace"
)

type RuntimeSetting struct {
	ID          string                 `json:"id"`
	Scope       RuntimeSettingScope    `json:"scope"`
	ProjectID   string                 `json:"projectId,omitempty"`
	WorkspaceID string                 `json:"workspaceId,omitempty"`
	Key         string                 `json:"key"`
	Value       map[string]interface{} `json:"value"`
	UpdatedAt   time.Time              `json:"updatedAt"`
}

type SetRuntimeSettingRequest struct {
	Scope       RuntimeSettingScope    `json:"scope,omitempty"`
	ProjectID   string                 `json:"projectId,omitempty"`
	WorkspaceID string                 `json:"workspaceId,omitempty"`
	Key         string                 `json:"key"`
	Value       map[string]interface{} `json:"value"`
}

type RuntimeSettingFilter struct {
	Scope       RuntimeSettingScope
	ProjectID   string
	WorkspaceID string
	Key         string
}

type Keybinding struct {
	ID          string    `json:"id"`
	Command     string    `json:"command"`
	Accelerator string    `json:"accelerator"`
	Platform    string    `json:"platform,omitempty"`
	Context     string    `json:"context,omitempty"`
	Enabled     bool      `json:"enabled"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type SetKeybindingRequest struct {
	Command     string `json:"command"`
	Accelerator string `json:"accelerator"`
	Platform    string `json:"platform,omitempty"`
	Context     string `json:"context,omitempty"`
	Enabled     *bool  `json:"enabled,omitempty"`
}

type KeybindingFilter struct {
	Platform string
	Context  string
	Command  string
}

func (m *Manager) SetRuntimeSetting(req SetRuntimeSettingRequest) (RuntimeSetting, error) {
	scope := req.Scope
	if scope == "" {
		scope = RuntimeSettingGlobal
	}
	if !isRuntimeSettingScope(scope) {
		return RuntimeSetting{}, errors.New("invalid setting scope")
	}
	key := strings.TrimSpace(req.Key)
	if key == "" {
		return RuntimeSetting{}, errors.New("setting key is required")
	}
	projectID := strings.TrimSpace(req.ProjectID)
	workspaceID := strings.TrimSpace(req.WorkspaceID)
	if scope == RuntimeSettingProject && projectID == "" {
		return RuntimeSetting{}, errors.New("project-scoped settings require project id")
	}
	if scope == RuntimeSettingWorkspace && workspaceID == "" {
		return RuntimeSetting{}, errors.New("workspace-scoped settings require workspace id")
	}
	now := time.Now().UTC()
	id := settingKey(scope, projectID, workspaceID, key)
	setting := RuntimeSetting{
		ID:          id,
		Scope:       scope,
		ProjectID:   projectID,
		WorkspaceID: workspaceID,
		Key:         key,
		Value:       cloneMap(req.Value),
		UpdatedAt:   now,
	}
	m.mu.Lock()
	m.settings[id] = setting
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return RuntimeSetting{}, err
	}
	m.emit("settings.changed", setting)
	return setting, nil
}

func (m *Manager) ListRuntimeSettings(filter RuntimeSettingFilter) []RuntimeSetting {
	m.mu.RLock()
	defer m.mu.RUnlock()
	settings := make([]RuntimeSetting, 0, len(m.settings))
	for _, setting := range m.settings {
		if filter.Scope != "" && setting.Scope != filter.Scope {
			continue
		}
		if filter.ProjectID != "" && setting.ProjectID != filter.ProjectID {
			continue
		}
		if filter.WorkspaceID != "" && setting.WorkspaceID != filter.WorkspaceID {
			continue
		}
		if filter.Key != "" && setting.Key != filter.Key {
			continue
		}
		settings = append(settings, setting)
	}
	sort.Slice(settings, func(i, j int) bool {
		return settings[i].ID < settings[j].ID
	})
	return settings
}

func (m *Manager) SetKeybinding(req SetKeybindingRequest) (Keybinding, error) {
	command := strings.TrimSpace(req.Command)
	accelerator := strings.TrimSpace(req.Accelerator)
	if command == "" || accelerator == "" {
		return Keybinding{}, errors.New("keybinding command and accelerator are required")
	}
	platform := normalizeKeybindingPlatform(req.Platform)
	context := strings.TrimSpace(req.Context)
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	now := time.Now().UTC()
	id := keybindingKey(platform, context, command)
	keybinding := Keybinding{
		ID:          id,
		Command:     command,
		Accelerator: accelerator,
		Platform:    platform,
		Context:     context,
		Enabled:     enabled,
		UpdatedAt:   now,
	}
	m.mu.Lock()
	m.keybindings[id] = keybinding
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return Keybinding{}, err
	}
	m.emit("settings.changed", keybinding)
	return keybinding, nil
}

func (m *Manager) ListKeybindings(filter KeybindingFilter) []Keybinding {
	m.mu.RLock()
	defer m.mu.RUnlock()
	platform := normalizeKeybindingPlatform(filter.Platform)
	keybindings := make([]Keybinding, 0, len(m.keybindings))
	for _, keybinding := range m.keybindings {
		if platform != "" && keybinding.Platform != platform {
			continue
		}
		if filter.Context != "" && keybinding.Context != filter.Context {
			continue
		}
		if filter.Command != "" && keybinding.Command != filter.Command {
			continue
		}
		keybindings = append(keybindings, keybinding)
	}
	sort.Slice(keybindings, func(i, j int) bool {
		return keybindings[i].ID < keybindings[j].ID
	})
	return keybindings
}

func settingKey(scope RuntimeSettingScope, projectID string, workspaceID string, key string) string {
	return string(scope) + "|" + strings.TrimSpace(projectID) + "|" + strings.TrimSpace(workspaceID) + "|" + strings.TrimSpace(key)
}

func keybindingKey(platform string, context string, command string) string {
	return normalizeKeybindingPlatform(platform) + "|" + strings.TrimSpace(context) + "|" + strings.TrimSpace(command)
}

func isRuntimeSettingScope(scope RuntimeSettingScope) bool {
	switch scope {
	case RuntimeSettingGlobal, RuntimeSettingProject, RuntimeSettingWorkspace:
		return true
	default:
		return false
	}
}

func normalizeKeybindingPlatform(platform string) string {
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "", "all":
		return ""
	case "mac", "macos", "darwin":
		return "macos"
	case "win", "windows":
		return "windows"
	case "linux":
		return "linux"
	default:
		return strings.ToLower(strings.TrimSpace(platform))
	}
}
