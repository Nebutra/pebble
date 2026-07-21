package runtimecore

import (
	"errors"
	"sort"
	"strings"
	"time"
)

type ExternalWorkItemKind string

const (
	ExternalWorkItemIssue  ExternalWorkItemKind = "issue"
	ExternalWorkItemTicket ExternalWorkItemKind = "ticket"
	ExternalWorkItemReview ExternalWorkItemKind = "review"
)

type ExternalWorkItemStatus string

const (
	ExternalWorkItemOpen       ExternalWorkItemStatus = "open"
	ExternalWorkItemInProgress ExternalWorkItemStatus = "inProgress"
	ExternalWorkItemClosed     ExternalWorkItemStatus = "closed"
	ExternalWorkItemMerged     ExternalWorkItemStatus = "merged"
	ExternalWorkItemBlocked    ExternalWorkItemStatus = "blocked"
	ExternalWorkItemUnknown    ExternalWorkItemStatus = "unknown"
)

type ExternalWorkItem struct {
	ID           string                 `json:"id"`
	Provider     string                 `json:"provider"`
	Kind         ExternalWorkItemKind   `json:"kind"`
	ExternalID   string                 `json:"externalId"`
	URL          string                 `json:"url,omitempty"`
	Title        string                 `json:"title"`
	Status       ExternalWorkItemStatus `json:"status"`
	Assignee     string                 `json:"assignee,omitempty"`
	ProjectID    string                 `json:"projectId,omitempty"`
	TaskID       string                 `json:"taskId,omitempty"`
	RepositoryID string                 `json:"repositoryId,omitempty"`
	WorkspaceID  string                 `json:"workspaceId,omitempty"`
	ReviewKind   string                 `json:"reviewKind,omitempty"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
	LastSyncedAt *time.Time             `json:"lastSyncedAt,omitempty"`
	CreatedAt    time.Time              `json:"createdAt"`
	UpdatedAt    time.Time              `json:"updatedAt"`
}

type UpsertExternalWorkItemRequest struct {
	Provider     string                 `json:"provider"`
	Kind         ExternalWorkItemKind   `json:"kind"`
	ExternalID   string                 `json:"externalId"`
	URL          string                 `json:"url,omitempty"`
	Title        string                 `json:"title"`
	Status       ExternalWorkItemStatus `json:"status,omitempty"`
	Assignee     string                 `json:"assignee,omitempty"`
	ProjectID    string                 `json:"projectId,omitempty"`
	TaskID       string                 `json:"taskId,omitempty"`
	CreateTask   bool                   `json:"createTask,omitempty"`
	RepositoryID string                 `json:"repositoryId,omitempty"`
	WorkspaceID  string                 `json:"workspaceId,omitempty"`
	ReviewKind   string                 `json:"reviewKind,omitempty"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
	SyncedAt     *time.Time             `json:"syncedAt,omitempty"`
}

type UpdateExternalWorkItemRequest struct {
	URL          string                 `json:"url,omitempty"`
	Title        string                 `json:"title,omitempty"`
	Status       ExternalWorkItemStatus `json:"status,omitempty"`
	Assignee     string                 `json:"assignee,omitempty"`
	ProjectID    string                 `json:"projectId,omitempty"`
	TaskID       string                 `json:"taskId,omitempty"`
	RepositoryID string                 `json:"repositoryId,omitempty"`
	WorkspaceID  string                 `json:"workspaceId,omitempty"`
	ReviewKind   string                 `json:"reviewKind,omitempty"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
	SyncedAt     *time.Time             `json:"syncedAt,omitempty"`
}

type ExternalWorkItemFilter struct {
	Provider     string
	Kind         ExternalWorkItemKind
	ProjectID    string
	TaskID       string
	RepositoryID string
	WorkspaceID  string
}

func (m *Manager) UpsertExternalWorkItem(req UpsertExternalWorkItemRequest) (ExternalWorkItem, error) {
	provider := normalizeExternalProvider(req.Provider)
	kind := req.Kind
	if kind == "" {
		kind = defaultExternalWorkItemKind(provider)
	}
	if !isExternalWorkItemKind(kind) {
		return ExternalWorkItem{}, errors.New("invalid external work item kind")
	}
	externalID := strings.TrimSpace(req.ExternalID)
	title := strings.TrimSpace(req.Title)
	if provider == "" || externalID == "" || title == "" {
		return ExternalWorkItem{}, errors.New("external provider, external id, and title are required")
	}
	status := req.Status
	if status == "" {
		status = ExternalWorkItemUnknown
	}
	if !isExternalWorkItemStatus(status) {
		return ExternalWorkItem{}, errors.New("invalid external work item status")
	}
	taskID := strings.TrimSpace(req.TaskID)
	if taskID != "" {
		if err := m.ensureTaskExists(taskID); err != nil {
			return ExternalWorkItem{}, err
		}
	}
	if req.CreateTask && taskID == "" {
		task, err := m.CreateTask(CreateTaskRequest{
			Title:    title,
			Body:     externalWorkItemTaskBody(req.URL, provider, externalID),
			Assignee: strings.TrimSpace(req.Assignee),
		})
		if err != nil {
			return ExternalWorkItem{}, err
		}
		taskID = task.ID
	}
	now := time.Now().UTC()
	syncedAt := now
	if req.SyncedAt != nil {
		syncedAt = req.SyncedAt.UTC()
	}
	m.mu.Lock()
	item, ok := m.findExternalWorkItemLocked(provider, externalID)
	if !ok {
		item = ExternalWorkItem{
			ID:         newID("ext"),
			Provider:   provider,
			Kind:       kind,
			ExternalID: externalID,
			CreatedAt:  now,
		}
	}
	item.Kind = kind
	item.URL = strings.TrimSpace(req.URL)
	item.Title = title
	item.Status = status
	item.Assignee = strings.TrimSpace(req.Assignee)
	item.ProjectID = strings.TrimSpace(req.ProjectID)
	item.TaskID = taskID
	item.RepositoryID = strings.TrimSpace(req.RepositoryID)
	item.WorkspaceID = strings.TrimSpace(req.WorkspaceID)
	item.ReviewKind = externalReviewKind(req.ReviewKind)
	item.Metadata = cloneMap(req.Metadata)
	item.LastSyncedAt = &syncedAt
	item.UpdatedAt = now
	m.externalWorkItems[item.ID] = item
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ExternalWorkItem{}, err
	}
	m.emit("external-task.changed", item)
	return item, nil
}

func (m *Manager) UpdateExternalWorkItem(id string, req UpdateExternalWorkItemRequest) (ExternalWorkItem, error) {
	if req.Status != "" && !isExternalWorkItemStatus(req.Status) {
		return ExternalWorkItem{}, errors.New("invalid external work item status")
	}
	taskID := strings.TrimSpace(req.TaskID)
	if taskID != "" {
		if err := m.ensureTaskExists(taskID); err != nil {
			return ExternalWorkItem{}, err
		}
	}
	m.mu.Lock()
	item, ok := m.externalWorkItems[id]
	if !ok {
		m.mu.Unlock()
		return ExternalWorkItem{}, ErrNotFound
	}
	if url := strings.TrimSpace(req.URL); url != "" {
		item.URL = url
	}
	if title := strings.TrimSpace(req.Title); title != "" {
		item.Title = title
	}
	if req.Status != "" {
		item.Status = req.Status
	}
	if assignee := strings.TrimSpace(req.Assignee); assignee != "" {
		item.Assignee = assignee
	}
	if projectID := strings.TrimSpace(req.ProjectID); projectID != "" {
		item.ProjectID = projectID
	}
	if taskID != "" {
		item.TaskID = taskID
	}
	if repositoryID := strings.TrimSpace(req.RepositoryID); repositoryID != "" {
		item.RepositoryID = repositoryID
	}
	if workspaceID := strings.TrimSpace(req.WorkspaceID); workspaceID != "" {
		item.WorkspaceID = workspaceID
	}
	if reviewKind := externalReviewKind(req.ReviewKind); reviewKind != "" {
		item.ReviewKind = reviewKind
	}
	if req.Metadata != nil {
		item.Metadata = cloneMap(req.Metadata)
	}
	if req.SyncedAt != nil {
		syncedAt := req.SyncedAt.UTC()
		item.LastSyncedAt = &syncedAt
	}
	item.UpdatedAt = time.Now().UTC()
	m.externalWorkItems[id] = item
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ExternalWorkItem{}, err
	}
	m.emit("external-task.changed", item)
	return item, nil
}

func (m *Manager) DeleteExternalWorkItem(id string) (ExternalWorkItem, error) {
	m.mu.Lock()
	item, ok := m.externalWorkItems[id]
	if !ok {
		m.mu.Unlock()
		return ExternalWorkItem{}, ErrNotFound
	}
	delete(m.externalWorkItems, id)
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ExternalWorkItem{}, err
	}
	m.emit("external-task.changed", map[string]interface{}{"deleted": item})
	return item, nil
}

func (m *Manager) ListExternalWorkItems(filter ExternalWorkItemFilter) []ExternalWorkItem {
	filter.Provider = normalizeExternalProvider(filter.Provider)
	m.mu.RLock()
	defer m.mu.RUnlock()
	items := make([]ExternalWorkItem, 0, len(m.externalWorkItems))
	for _, item := range m.externalWorkItems {
		if filter.Provider != "" && item.Provider != filter.Provider {
			continue
		}
		if filter.Kind != "" && item.Kind != filter.Kind {
			continue
		}
		if filter.ProjectID != "" && item.ProjectID != filter.ProjectID {
			continue
		}
		if filter.TaskID != "" && item.TaskID != filter.TaskID {
			continue
		}
		if filter.RepositoryID != "" && item.RepositoryID != filter.RepositoryID {
			continue
		}
		if filter.WorkspaceID != "" && item.WorkspaceID != filter.WorkspaceID {
			continue
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Provider == items[j].Provider {
			return items[i].ExternalID < items[j].ExternalID
		}
		return items[i].Provider < items[j].Provider
	})
	return items
}

func (m *Manager) ensureTaskExists(taskID string) error {
	m.mu.RLock()
	_, ok := m.tasks[taskID]
	m.mu.RUnlock()
	if !ok {
		return ErrNotFound
	}
	return nil
}

func (m *Manager) findExternalWorkItemLocked(provider string, externalID string) (ExternalWorkItem, bool) {
	for _, item := range m.externalWorkItems {
		if item.Provider == provider && item.ExternalID == externalID {
			return item, true
		}
	}
	return ExternalWorkItem{}, false
}

func normalizeExternalProvider(provider string) string {
	provider = strings.ToLower(strings.TrimSpace(provider))
	switch provider {
	case "azure", "azuredevops", "azure-devops":
		return "azure-devops"
	case "bitbucket", "generic", "github", "gitlab", "jira", "linear":
		return provider
	default:
		return provider
	}
}

func defaultExternalWorkItemKind(provider string) ExternalWorkItemKind {
	switch provider {
	case "github", "gitlab", "bitbucket", "azure-devops":
		return ExternalWorkItemReview
	case "linear", "jira":
		return ExternalWorkItemTicket
	default:
		return ExternalWorkItemIssue
	}
}

func externalReviewKind(kind string) string {
	trimmed := strings.TrimSpace(kind)
	if trimmed == "" {
		return ""
	}
	normalized := reviewKind(trimmed)
	if normalized == "none" {
		return trimmed
	}
	return normalized
}

func isExternalWorkItemKind(kind ExternalWorkItemKind) bool {
	switch kind {
	case ExternalWorkItemIssue, ExternalWorkItemTicket, ExternalWorkItemReview:
		return true
	default:
		return false
	}
}

func isExternalWorkItemStatus(status ExternalWorkItemStatus) bool {
	switch status {
	case ExternalWorkItemOpen, ExternalWorkItemInProgress, ExternalWorkItemClosed, ExternalWorkItemMerged, ExternalWorkItemBlocked, ExternalWorkItemUnknown:
		return true
	default:
		return false
	}
}

func externalWorkItemTaskBody(itemURL string, provider string, externalID string) string {
	itemURL = strings.TrimSpace(itemURL)
	if itemURL == "" {
		return "Imported from " + provider + " " + externalID + "."
	}
	return "Imported from " + provider + " " + externalID + ": " + itemURL
}
