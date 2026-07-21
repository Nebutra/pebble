package runtimecore

import (
	"errors"
	"path"
	"sort"
	"strings"
	"time"
)

type SparsePreset struct {
	ID          string   `json:"id"`
	RepoID      string   `json:"repoId"`
	Name        string   `json:"name"`
	Directories []string `json:"directories"`
	CreatedAt   int64    `json:"createdAt"`
	UpdatedAt   int64    `json:"updatedAt"`
}

type SaveSparsePresetRequest struct {
	ID          string   `json:"id,omitempty"`
	Name        string   `json:"name"`
	Directories []string `json:"directories"`
}

func (m *Manager) ListSparsePresets(repoID string) ([]SparsePreset, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if _, ok := m.projects[repoID]; !ok {
		return nil, ErrNotFound
	}
	result := append([]SparsePreset(nil), m.sparsePresets[repoID]...)
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func (m *Manager) SaveSparsePreset(repoID string, req SaveSparsePresetRequest) (SparsePreset, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return SparsePreset{}, errors.New("Preset name is required.")
	}
	if len([]rune(name)) > 80 {
		return SparsePreset{}, errors.New("Preset name is too long.")
	}
	directories, err := normalizeSparsePresetDirectories(req.Directories)
	if err != nil {
		return SparsePreset{}, err
	}
	m.mu.Lock()
	if _, ok := m.projects[repoID]; !ok {
		m.mu.Unlock()
		return SparsePreset{}, ErrNotFound
	}
	now := time.Now().UnixMilli()
	preset := SparsePreset{ID: strings.TrimSpace(req.ID), RepoID: repoID, Name: name, Directories: directories, CreatedAt: now, UpdatedAt: now}
	if preset.ID == "" {
		preset.ID = newID("sparse")
	}
	existing := m.sparsePresets[repoID]
	for index := range existing {
		if existing[index].ID == preset.ID {
			preset.CreatedAt = existing[index].CreatedAt
			existing[index] = preset
			m.sparsePresets[repoID] = existing
			err := m.saveLocked()
			m.mu.Unlock()
			if err != nil {
				return SparsePreset{}, err
			}
			m.emit("repo.sparse-presets.changed", map[string]string{"repoId": repoID})
			return preset, nil
		}
	}
	m.sparsePresets[repoID] = append(existing, preset)
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return SparsePreset{}, err
	}
	m.emit("repo.sparse-presets.changed", map[string]string{"repoId": repoID})
	return preset, nil
}

func (m *Manager) RemoveSparsePreset(repoID, presetID string) error {
	m.mu.Lock()
	if _, ok := m.projects[repoID]; !ok {
		m.mu.Unlock()
		return ErrNotFound
	}
	result := m.sparsePresets[repoID][:0]
	for _, preset := range m.sparsePresets[repoID] {
		if preset.ID != presetID {
			result = append(result, preset)
		}
	}
	m.sparsePresets[repoID] = result
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return err
	}
	m.emit("repo.sparse-presets.changed", map[string]string{"repoId": repoID})
	return nil
}

func normalizeSparsePresetDirectories(input []string) ([]string, error) {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range input {
		value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
		if value == "" || value == "." {
			continue
		}
		if strings.HasPrefix(value, "/") || (len(value) >= 3 && value[1] == ':' && value[2] == '/') {
			return nil, errors.New("Preset directories must be repo-relative paths.")
		}
		value = strings.Trim(value, "/")
		for _, segment := range strings.Split(value, "/") {
			if segment == ".." {
				return nil, errors.New("Preset directories must be repo-relative paths.")
			}
		}
		value = path.Clean(value)
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	if len(result) == 0 {
		return nil, errors.New("Preset must have at least one directory.")
	}
	return result, nil
}
