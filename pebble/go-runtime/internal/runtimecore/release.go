package runtimecore

import (
	"errors"
	"sort"
	"strings"
	"time"
)

type ReleasePlanStatus string

const (
	ReleasePlanDraft     ReleasePlanStatus = "draft"
	ReleasePlanReady     ReleasePlanStatus = "ready"
	ReleasePlanBlocked   ReleasePlanStatus = "blocked"
	ReleasePlanPublished ReleasePlanStatus = "published"
)

type ReleaseCheckStatus string

const (
	ReleaseCheckPending ReleaseCheckStatus = "pending"
	ReleaseCheckPassed  ReleaseCheckStatus = "passed"
	ReleaseCheckFailed  ReleaseCheckStatus = "failed"
)

type ReleaseRequiredArtifact struct {
	Platform string `json:"platform"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
}

type ReleaseArtifact struct {
	ID        string    `json:"id"`
	Platform  string    `json:"platform"`
	Kind      string    `json:"kind"`
	Name      string    `json:"name"`
	URI       string    `json:"uri"`
	SHA256    string    `json:"sha256,omitempty"`
	Size      int64     `json:"size,omitempty"`
	Signed    bool      `json:"signed,omitempty"`
	Notarized bool      `json:"notarized,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type ReleaseCheck struct {
	ID        string             `json:"id"`
	Name      string             `json:"name"`
	Status    ReleaseCheckStatus `json:"status"`
	Message   string             `json:"message,omitempty"`
	UpdatedAt time.Time          `json:"updatedAt"`
}

type ReleasePlan struct {
	ID                string                    `json:"id"`
	Version           string                    `json:"version"`
	Channel           string                    `json:"channel"`
	Status            ReleasePlanStatus         `json:"status"`
	RequiredArtifacts []ReleaseRequiredArtifact `json:"requiredArtifacts"`
	Artifacts         []ReleaseArtifact         `json:"artifacts"`
	Checks            []ReleaseCheck            `json:"checks"`
	UpdateManifestURI string                    `json:"updateManifestUri,omitempty"`
	BlockedReason     string                    `json:"blockedReason,omitempty"`
	CreatedAt         time.Time                 `json:"createdAt"`
	UpdatedAt         time.Time                 `json:"updatedAt"`
	PublishedAt       *time.Time                `json:"publishedAt,omitempty"`
}

type ReleaseUpdateManifest struct {
	ReleaseID         string                    `json:"releaseId"`
	Version           string                    `json:"version"`
	Channel           string                    `json:"channel"`
	Status            ReleasePlanStatus         `json:"status"`
	Ready             bool                      `json:"ready"`
	RequiredArtifacts []ReleaseRequiredArtifact `json:"requiredArtifacts"`
	Artifacts         []ReleaseManifestArtifact `json:"artifacts"`
	Checks            []ReleaseCheck            `json:"checks"`
	UpdateManifestURI string                    `json:"updateManifestUri,omitempty"`
	BlockedReason     string                    `json:"blockedReason,omitempty"`
	PublishedAt       *time.Time                `json:"publishedAt,omitempty"`
	GeneratedAt       time.Time                 `json:"generatedAt"`
}

type ReleaseManifestArtifact struct {
	Platform  string `json:"platform"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	URI       string `json:"uri"`
	SHA256    string `json:"sha256,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Signed    bool   `json:"signed,omitempty"`
	Notarized bool   `json:"notarized,omitempty"`
}

type CreateReleasePlanRequest struct {
	Version           string                    `json:"version"`
	Channel           string                    `json:"channel,omitempty"`
	RequiredArtifacts []ReleaseRequiredArtifact `json:"requiredArtifacts,omitempty"`
}

type UpdateReleasePlanRequest struct {
	Channel           string                    `json:"channel,omitempty"`
	Status            ReleasePlanStatus         `json:"status,omitempty"`
	RequiredArtifacts []ReleaseRequiredArtifact `json:"requiredArtifacts,omitempty"`
	UpdateManifestURI string                    `json:"updateManifestUri,omitempty"`
}

type UpsertReleaseArtifactRequest struct {
	Platform  string `json:"platform"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	URI       string `json:"uri"`
	SHA256    string `json:"sha256,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Signed    bool   `json:"signed,omitempty"`
	Notarized bool   `json:"notarized,omitempty"`
}

type UpdateReleaseCheckRequest struct {
	Name    string             `json:"name"`
	Status  ReleaseCheckStatus `json:"status"`
	Message string             `json:"message,omitempty"`
}

type PublishReleasePlanRequest struct {
	Force bool `json:"force,omitempty"`
}

func (m *Manager) CreateReleasePlan(req CreateReleasePlanRequest) (ReleasePlan, error) {
	version := strings.TrimSpace(req.Version)
	if version == "" {
		return ReleasePlan{}, errors.New("release version is required")
	}
	channel := strings.TrimSpace(req.Channel)
	if channel == "" {
		channel = "stable"
	}
	required, err := normalizeRequiredArtifacts(req.RequiredArtifacts)
	if err != nil {
		return ReleasePlan{}, err
	}
	if len(required) == 0 {
		required = defaultReleaseRequiredArtifacts()
	}
	now := time.Now().UTC()
	plan := ReleasePlan{
		ID:                newID("rel"),
		Version:           version,
		Channel:           channel,
		Status:            ReleasePlanDraft,
		RequiredArtifacts: required,
		Checks:            defaultReleaseChecks(now),
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	m.mu.Lock()
	m.releases[plan.ID] = plan
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ReleasePlan{}, err
	}
	m.emit("release.changed", plan)
	return plan, nil
}

func (m *Manager) UpdateReleasePlan(id string, req UpdateReleasePlanRequest) (ReleasePlan, error) {
	if req.Status != "" && !isReleasePlanStatus(req.Status) {
		return ReleasePlan{}, errors.New("invalid release status")
	}
	if req.Status == ReleasePlanReady || req.Status == ReleasePlanPublished {
		return ReleasePlan{}, errors.New("release ready/published status is computed by checks, artifacts, and publish gate")
	}
	statusSet := req.Status != ""
	requiredChanged := len(req.RequiredArtifacts) > 0
	m.mu.Lock()
	plan, ok := m.releases[id]
	if !ok {
		m.mu.Unlock()
		return ReleasePlan{}, ErrNotFound
	}
	if channel := strings.TrimSpace(req.Channel); channel != "" {
		plan.Channel = channel
	}
	if statusSet {
		plan.Status = req.Status
		if req.Status != ReleasePlanBlocked {
			plan.BlockedReason = ""
		}
	}
	if len(req.RequiredArtifacts) > 0 {
		required, err := normalizeRequiredArtifacts(req.RequiredArtifacts)
		if err != nil {
			m.mu.Unlock()
			return ReleasePlan{}, err
		}
		if len(required) == 0 {
			m.mu.Unlock()
			return ReleasePlan{}, errors.New("release required artifacts cannot be empty")
		}
		plan.RequiredArtifacts = required
	}
	if uri := strings.TrimSpace(req.UpdateManifestURI); uri != "" {
		plan.UpdateManifestURI = uri
	}
	if requiredChanged && !statusSet && plan.Status != ReleasePlanPublished {
		plan.Status, plan.BlockedReason = releaseReadiness(plan)
	}
	plan.UpdatedAt = time.Now().UTC()
	m.releases[id] = plan
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ReleasePlan{}, err
	}
	m.emit("release.changed", plan)
	return plan, nil
}

func (m *Manager) ListReleasePlans() []ReleasePlan {
	m.mu.RLock()
	defer m.mu.RUnlock()
	plans := make([]ReleasePlan, 0, len(m.releases))
	for _, plan := range m.releases {
		plans = append(plans, plan)
	}
	sort.Slice(plans, func(i, j int) bool {
		return plans[i].CreatedAt.Before(plans[j].CreatedAt)
	})
	return plans
}

func (m *Manager) GetReleaseUpdateManifest(releaseID string) (ReleaseUpdateManifest, error) {
	m.mu.RLock()
	plan, ok := m.releases[releaseID]
	m.mu.RUnlock()
	if !ok {
		return ReleaseUpdateManifest{}, ErrNotFound
	}

	return releaseUpdateManifest(plan, time.Now().UTC()), nil
}

func (m *Manager) UpsertReleaseArtifact(releaseID string, req UpsertReleaseArtifactRequest) (ReleasePlan, error) {
	artifact, err := normalizeReleaseArtifact(req)
	if err != nil {
		return ReleasePlan{}, err
	}
	now := time.Now().UTC()
	m.mu.Lock()
	plan, ok := m.releases[releaseID]
	if !ok {
		m.mu.Unlock()
		return ReleasePlan{}, ErrNotFound
	}
	replaced := false
	for index, existing := range plan.Artifacts {
		if sameReleaseArtifact(existing, artifact) {
			artifact.ID = existing.ID
			artifact.CreatedAt = existing.CreatedAt
			artifact.UpdatedAt = now
			plan.Artifacts[index] = artifact
			replaced = true
			break
		}
	}
	if !replaced {
		artifact.ID = newID("relart")
		artifact.CreatedAt = now
		artifact.UpdatedAt = now
		plan.Artifacts = append(plan.Artifacts, artifact)
	}
	if plan.Status != ReleasePlanPublished {
		plan.Status, plan.BlockedReason = releaseReadiness(plan)
	}
	plan.UpdatedAt = now
	m.releases[releaseID] = plan
	err = m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ReleasePlan{}, err
	}
	m.emit("release.changed", plan)
	return plan, nil
}

func (m *Manager) UpdateReleaseCheck(releaseID string, req UpdateReleaseCheckRequest) (ReleasePlan, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return ReleasePlan{}, errors.New("release check name is required")
	}
	if !isReleaseCheckStatus(req.Status) {
		return ReleasePlan{}, errors.New("invalid release check status")
	}
	now := time.Now().UTC()
	m.mu.Lock()
	plan, ok := m.releases[releaseID]
	if !ok {
		m.mu.Unlock()
		return ReleasePlan{}, ErrNotFound
	}
	updated := false
	for index, check := range plan.Checks {
		if check.Name == name {
			check.Status = req.Status
			check.Message = strings.TrimSpace(req.Message)
			check.UpdatedAt = now
			plan.Checks[index] = check
			updated = true
			break
		}
	}
	if !updated {
		plan.Checks = append(plan.Checks, ReleaseCheck{
			ID:        newID("relchk"),
			Name:      name,
			Status:    req.Status,
			Message:   strings.TrimSpace(req.Message),
			UpdatedAt: now,
		})
	}
	if plan.Status != ReleasePlanPublished {
		plan.Status, plan.BlockedReason = releaseReadiness(plan)
	}
	plan.UpdatedAt = now
	m.releases[releaseID] = plan
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ReleasePlan{}, err
	}
	m.emit("release.changed", plan)
	return plan, nil
}

func (m *Manager) PublishReleasePlan(releaseID string, req PublishReleasePlanRequest) (ReleasePlan, error) {
	now := time.Now().UTC()
	m.mu.Lock()
	plan, ok := m.releases[releaseID]
	if !ok {
		m.mu.Unlock()
		return ReleasePlan{}, ErrNotFound
	}
	status, reason := releaseReadiness(plan)
	if status != ReleasePlanReady && !req.Force {
		plan.Status = ReleasePlanBlocked
		plan.BlockedReason = reason
		plan.UpdatedAt = now
		m.releases[releaseID] = plan
		err := m.saveLocked()
		m.mu.Unlock()
		if err != nil {
			return ReleasePlan{}, err
		}
		m.emit("release.changed", plan)
		return plan, nil
	}
	plan.Status = ReleasePlanPublished
	plan.BlockedReason = ""
	plan.PublishedAt = &now
	plan.UpdatedAt = now
	m.releases[releaseID] = plan
	err := m.saveLocked()
	m.mu.Unlock()
	if err != nil {
		return ReleasePlan{}, err
	}
	m.emit("release.changed", plan)
	return plan, nil
}

func normalizeRequiredArtifacts(required []ReleaseRequiredArtifact) ([]ReleaseRequiredArtifact, error) {
	normalized := make([]ReleaseRequiredArtifact, 0, len(required))
	seen := make(map[string]bool)
	for _, artifact := range required {
		artifact.Platform = normalizeReleasePlatform(artifact.Platform)
		artifact.Kind = strings.TrimSpace(artifact.Kind)
		artifact.Name = strings.TrimSpace(artifact.Name)
		if artifact.Platform == "" || artifact.Kind == "" {
			return nil, errors.New("release required artifact platform and kind are required")
		}
		if !isReleaseArtifactPlatform(artifact.Platform) {
			return nil, errors.New("release artifact platform must be generic, linux, macos, or windows")
		}
		if artifact.Name == "" {
			artifact.Name = artifact.Kind
		}
		key := releaseArtifactKey(artifact.Platform, artifact.Kind, artifact.Name)
		if seen[key] {
			continue
		}
		seen[key] = true
		normalized = append(normalized, artifact)
	}
	sort.Slice(normalized, func(i, j int) bool {
		return releaseArtifactKey(normalized[i].Platform, normalized[i].Kind, normalized[i].Name) < releaseArtifactKey(normalized[j].Platform, normalized[j].Kind, normalized[j].Name)
	})
	return normalized, nil
}

func normalizeReleaseArtifact(req UpsertReleaseArtifactRequest) (ReleaseArtifact, error) {
	artifact := ReleaseArtifact{
		Platform:  normalizeReleasePlatform(req.Platform),
		Kind:      strings.TrimSpace(req.Kind),
		Name:      strings.TrimSpace(req.Name),
		URI:       strings.TrimSpace(req.URI),
		SHA256:    strings.TrimSpace(req.SHA256),
		Size:      req.Size,
		Signed:    req.Signed,
		Notarized: req.Notarized,
	}
	if artifact.Platform == "" || artifact.Kind == "" || artifact.URI == "" {
		return ReleaseArtifact{}, errors.New("release artifact platform, kind, and uri are required")
	}
	if !isReleaseArtifactPlatform(artifact.Platform) {
		return ReleaseArtifact{}, errors.New("release artifact platform must be generic, linux, macos, or windows")
	}
	if artifact.Size < 0 {
		return ReleaseArtifact{}, errors.New("release artifact size must be non-negative")
	}
	if artifact.SHA256 != "" && !isHexDigest(artifact.SHA256, 64) {
		return ReleaseArtifact{}, errors.New("release artifact sha256 must be a 64-character hex digest")
	}
	if artifact.Name == "" {
		artifact.Name = artifact.Kind
	}
	return artifact, nil
}

func releaseReadiness(plan ReleasePlan) (ReleasePlanStatus, string) {
	for _, required := range plan.RequiredArtifacts {
		if !releaseHasArtifact(plan.Artifacts, required) {
			return ReleasePlanBlocked, "missing artifact " + releaseArtifactKey(required.Platform, required.Kind, required.Name)
		}
	}
	for _, check := range plan.Checks {
		if check.Status == ReleaseCheckFailed {
			return ReleasePlanBlocked, "failed check " + check.Name
		}
		if check.Status != ReleaseCheckPassed {
			return ReleasePlanBlocked, "pending check " + check.Name
		}
	}
	return ReleasePlanReady, ""
}

func releaseHasArtifact(artifacts []ReleaseArtifact, required ReleaseRequiredArtifact) bool {
	for _, artifact := range artifacts {
		if releaseArtifactKey(artifact.Platform, artifact.Kind, artifact.Name) == releaseArtifactKey(required.Platform, required.Kind, required.Name) {
			return true
		}
	}
	return false
}

func releaseUpdateManifest(plan ReleasePlan, generatedAt time.Time) ReleaseUpdateManifest {
	status, reason := releaseReadiness(plan)
	if status == ReleasePlanReady {
		reason = ""
	}
	artifacts := make([]ReleaseManifestArtifact, 0, len(plan.Artifacts))
	for _, artifact := range plan.Artifacts {
		artifacts = append(artifacts, ReleaseManifestArtifact{
			Platform:  artifact.Platform,
			Kind:      artifact.Kind,
			Name:      artifact.Name,
			URI:       artifact.URI,
			SHA256:    artifact.SHA256,
			Size:      artifact.Size,
			Signed:    artifact.Signed,
			Notarized: artifact.Notarized,
		})
	}
	sort.Slice(artifacts, func(i, j int) bool {
		return releaseArtifactKey(artifacts[i].Platform, artifacts[i].Kind, artifacts[i].Name) < releaseArtifactKey(artifacts[j].Platform, artifacts[j].Kind, artifacts[j].Name)
	})

	checks := append([]ReleaseCheck(nil), plan.Checks...)
	sort.Slice(checks, func(i, j int) bool {
		return checks[i].Name < checks[j].Name
	})

	return ReleaseUpdateManifest{
		ReleaseID:         plan.ID,
		Version:           plan.Version,
		Channel:           plan.Channel,
		Status:            plan.Status,
		Ready:             status == ReleasePlanReady,
		RequiredArtifacts: append([]ReleaseRequiredArtifact(nil), plan.RequiredArtifacts...),
		Artifacts:         artifacts,
		Checks:            checks,
		UpdateManifestURI: plan.UpdateManifestURI,
		BlockedReason:     reason,
		PublishedAt:       plan.PublishedAt,
		GeneratedAt:       generatedAt,
	}
}

func sameReleaseArtifact(left ReleaseArtifact, right ReleaseArtifact) bool {
	return releaseArtifactKey(left.Platform, left.Kind, left.Name) == releaseArtifactKey(right.Platform, right.Kind, right.Name)
}

func releaseArtifactKey(platform string, kind string, name string) string {
	return strings.TrimSpace(platform) + ":" + strings.TrimSpace(kind) + ":" + strings.TrimSpace(name)
}

func normalizeReleasePlatform(platform string) string {
	return strings.ToLower(strings.TrimSpace(platform))
}

func isReleaseArtifactPlatform(platform string) bool {
	switch platform {
	case "generic", "linux", "macos", "windows":
		return true
	default:
		return false
	}
}

func isHexDigest(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, current := range value {
		if !((current >= '0' && current <= '9') || (current >= 'a' && current <= 'f') || (current >= 'A' && current <= 'F')) {
			return false
		}
	}
	return true
}

func defaultReleaseRequiredArtifacts() []ReleaseRequiredArtifact {
	return []ReleaseRequiredArtifact{
		{Platform: "generic", Kind: "updaterManifest", Name: "latest"},
		{Platform: "linux", Kind: "package", Name: "pebble"},
		{Platform: "macos", Kind: "appArchive", Name: "dmg-or-zip"},
		{Platform: "windows", Kind: "appArchive", Name: "nsis"},
	}
}

func defaultReleaseChecks(now time.Time) []ReleaseCheck {
	return []ReleaseCheck{
		{ID: newID("relchk"), Name: "android-mobile-build", Status: ReleaseCheckPending, UpdatedAt: now},
		{ID: newID("relchk"), Name: "ios-mobile-build", Status: ReleaseCheckPending, UpdatedAt: now},
		{ID: newID("relchk"), Name: "macos-notarization", Status: ReleaseCheckPending, UpdatedAt: now},
		{ID: newID("relchk"), Name: "mobile-relay-crypto-native", Status: ReleaseCheckPending, UpdatedAt: now},
		{ID: newID("relchk"), Name: "windows-signing", Status: ReleaseCheckPending, UpdatedAt: now},
		{ID: newID("relchk"), Name: "linux-package-name", Status: ReleaseCheckPending, UpdatedAt: now},
		{ID: newID("relchk"), Name: "telemetry-constants", Status: ReleaseCheckPending, UpdatedAt: now},
		{ID: newID("relchk"), Name: "update-manifest", Status: ReleaseCheckPending, UpdatedAt: now},
	}
}

func isReleasePlanStatus(status ReleasePlanStatus) bool {
	switch status {
	case ReleasePlanDraft, ReleasePlanReady, ReleasePlanBlocked, ReleasePlanPublished:
		return true
	default:
		return false
	}
}

func isReleaseCheckStatus(status ReleaseCheckStatus) bool {
	switch status {
	case ReleaseCheckPending, ReleaseCheckPassed, ReleaseCheckFailed:
		return true
	default:
		return false
	}
}
