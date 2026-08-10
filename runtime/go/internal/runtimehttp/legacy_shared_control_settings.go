package runtimehttp

import (
	"encoding/json"
	"errors"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

// The web client mirrors a small set of global settings on the runtime so a
// paired browser reopens with the look the host was left in. Only these keys
// cross the wire; everything else stays client-local.
var legacySharedControlBooleanSettingKeys = []string{
	"experimentalNewWorktreeCardStyle",
	"compactWorktreeCards",
}

var legacySharedControlStringSettingKeys = []string{
	"minimaxGroupId",
	"minimaxUsageModels",
}

const legacySharedControlSettingValueField = "value"

func (s *Server) runLegacySharedControlSettingsMethod(method string, raw json.RawMessage) (interface{}, bool, error) {
	switch method {
	case "settings.get":
		return map[string]interface{}{"settings": s.readLegacySharedControlSettings()}, true, nil
	case "settings.update":
		var updates map[string]interface{}
		if len(raw) > 0 && json.Unmarshal(raw, &updates) != nil {
			return nil, true, errors.New("invalid settings update parameters")
		}
		if err := s.writeLegacySharedControlSettings(updates); err != nil {
			return nil, true, err
		}
		return map[string]interface{}{"settings": s.readLegacySharedControlSettings()}, true, nil
	default:
		return nil, false, nil
	}
}

func (s *Server) readLegacySharedControlSettings() map[string]interface{} {
	stored := make(map[string]interface{})
	for _, setting := range s.manager.ListRuntimeSettings(runtimecore.RuntimeSettingFilter{Scope: runtimecore.RuntimeSettingGlobal}) {
		if value, present := setting.Value[legacySharedControlSettingValueField]; present {
			stored[setting.Key] = value
		}
	}
	settings := make(map[string]interface{})
	for _, key := range legacySharedControlBooleanSettingKeys {
		if value, ok := stored[key].(bool); ok {
			settings[key] = value
		}
	}
	for _, key := range legacySharedControlStringSettingKeys {
		if value, ok := stored[key].(string); ok {
			settings[key] = value
		}
	}
	return settings
}

func (s *Server) writeLegacySharedControlSettings(updates map[string]interface{}) error {
	// Why: an unrecognised or wrongly typed key is dropped rather than stored,
	// so a newer client cannot seed values this runtime will never read back.
	for _, key := range legacySharedControlBooleanSettingKeys {
		value, ok := updates[key].(bool)
		if !ok {
			continue
		}
		if err := s.setLegacySharedControlSetting(key, value); err != nil {
			return err
		}
	}
	for _, key := range legacySharedControlStringSettingKeys {
		value, ok := updates[key].(string)
		if !ok {
			continue
		}
		if err := s.setLegacySharedControlSetting(key, value); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) setLegacySharedControlSetting(key string, value interface{}) error {
	_, err := s.manager.SetRuntimeSetting(runtimecore.SetRuntimeSettingRequest{
		Scope: runtimecore.RuntimeSettingGlobal,
		Key:   key,
		Value: map[string]interface{}{legacySharedControlSettingValueField: value},
	})
	return err
}
