package runtimecore

import (
	"errors"
	"sort"
	"strings"
	"time"
)

type ProjectHostSetup struct {
	ID               string    `json:"id"`
	ProjectID        string    `json:"projectId"`
	HostID           string    `json:"hostId"`
	RepoID           string    `json:"repoId"`
	Path             string    `json:"path"`
	DisplayName      string    `json:"displayName"`
	Kind             string    `json:"kind,omitempty"`
	WorktreeBasePath string    `json:"worktreeBasePath,omitempty"`
	GitUsername      string    `json:"gitUsername,omitempty"`
	SetupState       string    `json:"setupState"`
	SetupMethod      string    `json:"setupMethod"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type CreateProjectHostSetupRequest struct {
	ProjectID        string `json:"projectId"`
	HostID           string `json:"hostId"`
	SetupID          string `json:"setupId,omitempty"`
	Path             string `json:"path,omitempty"`
	DisplayName      string `json:"displayName,omitempty"`
	Kind             string `json:"kind,omitempty"`
	WorktreeBasePath string `json:"worktreeBasePath,omitempty"`
	GitUsername      string `json:"gitUsername,omitempty"`
	SetupState       string `json:"setupState,omitempty"`
	SetupMethod      string `json:"setupMethod,omitempty"`
}

type UpdateProjectHostSetupRequest struct {
	DisplayName      *string `json:"displayName,omitempty"`
	Path             *string `json:"path,omitempty"`
	Kind             *string `json:"kind,omitempty"`
	WorktreeBasePath *string `json:"worktreeBasePath,omitempty"`
	GitUsername      *string `json:"gitUsername,omitempty"`
	SetupState       *string `json:"setupState,omitempty"`
	SetupMethod      *string `json:"setupMethod,omitempty"`
}

func (m *Manager) ListProjectHostSetups() []ProjectHostSetup {
	m.mu.RLock()
	defer m.mu.RUnlock()
	setups := make([]ProjectHostSetup, 0, len(m.projectHostSetups))
	for _, setup := range m.projectHostSetups {
		setups = append(setups, setup)
	}
	sort.Slice(setups, func(i, j int) bool { return setups[i].CreatedAt.Before(setups[j].CreatedAt) })
	return setups
}

func (m *Manager) CreateProjectHostSetup(req CreateProjectHostSetupRequest) (ProjectHostSetup, error) {
	projectID := strings.TrimSpace(req.ProjectID)
	hostID := strings.TrimSpace(req.HostID)
	if projectID == "" || hostID == "" {
		return ProjectHostSetup{}, errors.New("project and host ids are required")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	projectName := ""
	for _, project := range m.projects {
		logicalID := project.LogicalProjectID
		if logicalID == "" {
			logicalID = "repo:" + project.ID
		}
		if logicalID != projectID {
			continue
		}
		projectName = project.Name
		projectHostID := "local"
		if project.LocationKind == "ssh" {
			projectHostID = "ssh:" + project.HostID
		}
		if projectHostID == hostID {
			return ProjectHostSetup{}, errors.New("project host setup already exists")
		}
	}
	if projectName == "" {
		return ProjectHostSetup{}, ErrNotFound
	}
	for _, setup := range m.projectHostSetups {
		if setup.ProjectID == projectID && setup.HostID == hostID {
			return ProjectHostSetup{}, errors.New("project host setup already exists")
		}
	}
	setupID := strings.TrimSpace(req.SetupID)
	if setupID == "" {
		setupID = projectID + "::" + hostID
	}
	if _, exists := m.projectHostSetups[setupID]; exists {
		return ProjectHostSetup{}, errors.New("project host setup id already exists")
	}
	now := time.Now().UTC()
	setup := ProjectHostSetup{
		ID:               setupID,
		ProjectID:        projectID,
		HostID:           hostID,
		Path:             strings.TrimSpace(req.Path),
		DisplayName:      strings.TrimSpace(req.DisplayName),
		Kind:             strings.TrimSpace(req.Kind),
		WorktreeBasePath: strings.TrimSpace(req.WorktreeBasePath),
		GitUsername:      strings.TrimSpace(req.GitUsername),
		SetupState:       normalizeProjectHostSetupState(req.SetupState, "not-set-up"),
		SetupMethod:      normalizeProjectHostSetupMethod(req.SetupMethod, "provisioned"),
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	if setup.DisplayName == "" {
		setup.DisplayName = projectName
	}
	m.projectHostSetups[setup.ID] = setup
	if err := m.saveLocked(); err != nil {
		delete(m.projectHostSetups, setup.ID)
		return ProjectHostSetup{}, err
	}
	return setup, nil
}

func (m *Manager) UpdateProjectHostSetup(id string, req UpdateProjectHostSetupRequest) (ProjectHostSetup, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	setup, ok := m.projectHostSetups[id]
	if !ok {
		return ProjectHostSetup{}, ErrNotFound
	}
	applyOptionalString(req.DisplayName, &setup.DisplayName)
	applyOptionalString(req.Path, &setup.Path)
	applyOptionalString(req.Kind, &setup.Kind)
	applyOptionalString(req.WorktreeBasePath, &setup.WorktreeBasePath)
	applyOptionalString(req.GitUsername, &setup.GitUsername)
	if req.SetupState != nil {
		setup.SetupState = normalizeProjectHostSetupState(*req.SetupState, setup.SetupState)
	}
	if req.SetupMethod != nil {
		setup.SetupMethod = normalizeProjectHostSetupMethod(*req.SetupMethod, setup.SetupMethod)
	}
	setup.UpdatedAt = time.Now().UTC()
	m.projectHostSetups[id] = setup
	if err := m.saveLocked(); err != nil {
		return ProjectHostSetup{}, err
	}
	return setup, nil
}

func (m *Manager) DeleteProjectHostSetup(id string) (ProjectHostSetup, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	setup, ok := m.projectHostSetups[id]
	if !ok {
		return ProjectHostSetup{}, ErrNotFound
	}
	delete(m.projectHostSetups, id)
	if err := m.saveLocked(); err != nil {
		m.projectHostSetups[id] = setup
		return ProjectHostSetup{}, err
	}
	return setup, nil
}

func applyOptionalString(value *string, target *string) {
	if value != nil {
		*target = strings.TrimSpace(*value)
	}
}

func normalizeProjectHostSetupState(value string, fallback string) string {
	switch strings.TrimSpace(value) {
	case "ready", "not-set-up", "setting-up", "error", "unsupported":
		return strings.TrimSpace(value)
	default:
		return fallback
	}
}

func normalizeProjectHostSetupMethod(value string, fallback string) string {
	switch strings.TrimSpace(value) {
	case "legacy-repo", "imported-existing-folder", "cloned", "provisioned":
		return strings.TrimSpace(value)
	default:
		return fallback
	}
}
