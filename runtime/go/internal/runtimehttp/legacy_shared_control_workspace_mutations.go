package runtimehttp

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func (s *Server) runLegacySharedControlWorkspaceMutation(method string, raw json.RawMessage) (interface{}, bool, error) {
	switch method {
	case "projectGroup.scanNested":
		var request runtimecore.NestedRepoScanRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid nested repository scan parameters")
		}
		result, err := s.manager.ScanNestedRepos(context.Background(), request)
		return result, true, err
	case "projectGroup.importNested":
		var request runtimecore.ProjectGroupImportNestedRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid nested repository import parameters")
		}
		result, err := s.manager.ImportNestedRepos(context.Background(), request)
		return result, true, err
	case "repo.clone":
		var request runtimecore.CloneProjectRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid repository clone parameters")
		}
		project, err := s.manager.CloneProject(context.Background(), request)
		return map[string]interface{}{"repo": runtimeRPCProject(project)}, true, err
	case "repo.add":
		var request struct {
			Path string `json:"path"`
			Kind string `json:"kind"`
		}
		if json.Unmarshal(raw, &request) != nil || strings.TrimSpace(request.Path) == "" {
			return nil, true, errors.New("repository path is required")
		}
		project, err := s.manager.CreateProjectWithMainWorktree(context.Background(), runtimecore.CreateProjectRequest{
			Path: request.Path, LocationKind: "local", Provider: request.Kind,
		})
		return map[string]interface{}{"repo": runtimeRPCProject(project)}, true, err
	case "repo.create":
		var request struct {
			ParentPath string `json:"parentPath"`
			Name       string `json:"name"`
			Kind       string `json:"kind"`
		}
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid repository create parameters")
		}
		project, err := s.manager.CreateProjectOnHost(context.Background(), request.ParentPath, request.Name, request.Kind)
		if err != nil {
			return map[string]string{"error": err.Error()}, true, nil
		}
		return map[string]interface{}{"repo": runtimeRPCProject(project)}, true, nil
	case "repo.show":
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceMutationID(raw, "repo"))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		return map[string]interface{}{"repo": runtimeRPCProject(project)}, true, nil
	case "repo.update":
		return s.updateLegacySharedControlProject(raw)
	case "repo.rm":
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceMutationID(raw, "repo"))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		_, err := s.manager.DeleteProject(project.ID)
		return map[string]interface{}{"removed": err == nil}, true, err
	case "repo.reorder":
		var request runtimecore.PersistProjectSortOrderRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid repository sort order")
		}
		err := s.manager.PersistProjectSortOrder(request.OrderedIDs)
		return map[string]string{"status": "applied"}, true, err
	case "repo.gitAvailable":
		_, err := exec.LookPath("git")
		return map[string]bool{"available": err == nil}, true, nil
	case "repo.baseRefDefault":
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		result, err := s.manager.HostGitBaseRefDefault(context.Background(), project.ID)
		return result, true, err
	case "repo.searchRefs":
		var request struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid repository ref search parameters")
		}
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		details, truncated, err := s.manager.SearchHostGitBaseRefs(context.Background(), project.ID, request.Query, request.Limit)
		refs := make([]string, 0, len(details))
		for _, detail := range details {
			refs = append(refs, detail.RefName)
		}
		return map[string]interface{}{"refs": refs, "refDetails": details, "truncated": truncated}, true, err
	case "repo.hooksCheck":
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		result, err := s.manager.CheckProjectHooks(context.Background(), project.ID)
		return result, true, err
	case "repo.setupScriptImports":
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		result, err := s.manager.InspectProjectSetupScriptImports(context.Background(), project.ID)
		return result, true, err
	case "repo.issueCommandRead":
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		result, err := s.manager.ReadProjectIssueCommand(context.Background(), project.ID)
		return result, true, err
	case "repo.issueCommandWrite":
		var request struct {
			Content string `json:"content"`
		}
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid issue command parameters")
		}
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		err := s.manager.WriteProjectIssueCommand(context.Background(), project.ID, request.Content)
		return map[string]bool{"ok": err == nil}, true, err
	case "worktree.show":
		worktree, found := s.findLegacySharedControlWorktree(readLegacyWorkspaceMutationID(raw, "worktree"))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		return map[string]interface{}{"worktree": runtimeRPCWorktree(worktree)}, true, nil
	case "worktree.detectedList":
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		worktrees := s.manager.ListWorktrees(project.ID)
		projected := make([]map[string]interface{}, 0, len(worktrees))
		for _, worktree := range worktrees {
			entry := runtimeRPCWorktree(worktree)
			entry["ownership"] = "pebble-managed"
			entry["selectedCheckout"] = false
			entry["visible"] = true
			projected = append(projected, entry)
		}
		return map[string]interface{}{
			"repoId": project.ID, "authoritative": true, "source": "metadata-fallback", "worktrees": projected,
		}, true, nil
	case "worktree.create":
		return s.createLegacySharedControlWorktree(raw)
	case "worktree.prefetchCreateBase":
		var request struct {
			BaseBranch string `json:"baseBranch"`
		}
		_ = json.Unmarshal(raw, &request)
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		s.manager.PrefetchHostWorktreeBase(context.Background(), project.ID, request.BaseBranch)
		return nil, true, nil
	case "worktree.resolvePrBase", "worktree.resolveMrBase":
		var request struct {
			PRNumber          int    `json:"prNumber"`
			MRIID             int    `json:"mrIid"`
			HeadRefName       string `json:"headRefName"`
			BaseRefName       string `json:"baseRefName"`
			SourceBranch      string `json:"sourceBranch"`
			TargetBranch      string `json:"targetBranch"`
			IsCrossRepository bool   `json:"isCrossRepository"`
		}
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid review base parameters")
		}
		project, found := s.findLegacySharedControlProject(readLegacyWorkspaceProjectSelector(raw))
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		kind, number, head, base := "pr", request.PRNumber, request.HeadRefName, request.BaseRefName
		if method == "worktree.resolveMrBase" {
			kind, number, head, base = "mr", request.MRIID, request.SourceBranch, request.TargetBranch
		}
		result := s.manager.ResolveHostGitReviewStart(context.Background(), runtimecore.HostGitReviewStartRequest{
			ProjectID: project.ID, Kind: kind, Number: number, Head: head, Base: base, IsCrossRepository: request.IsCrossRepository,
		})
		return result, true, nil
	case "worktree.set":
		return s.updateLegacySharedControlWorktree(raw)
	case "worktree.persistSortOrder":
		var request runtimecore.PersistWorktreeSortOrderRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid worktree sort order")
		}
		err := s.manager.PersistWorktreeSortOrder(request.OrderedIDs)
		return map[string]string{"status": "applied"}, true, err
	case "worktree.forceDeleteBranch":
		var request struct {
			Worktree     string `json:"worktree"`
			WorktreeID   string `json:"worktreeId"`
			BranchName   string `json:"branchName"`
			ExpectedHead string `json:"expectedHead"`
		}
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid preserved branch cleanup parameters")
		}
		result, err := s.manager.ForceDeletePreservedBranchForWorktree(
			context.Background(), firstNonEmpty(request.Worktree, request.WorktreeID), request.BranchName, request.ExpectedHead,
		)
		return result, true, err
	case "worktree.rm", "worktree.remove":
		var request struct {
			Worktree string `json:"worktree"`
			Force    bool   `json:"force"`
			RunHooks bool   `json:"runHooks"`
		}
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid worktree removal parameters")
		}
		worktree, found := s.findLegacySharedControlWorktree(request.Worktree)
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		removed, err := s.manager.DeleteWorktree(context.Background(), worktree.ID, runtimecore.DeleteWorktreeRequest{
			ExecuteGit: true, Force: request.Force, SkipArchiveHook: !request.RunHooks,
		})
		return map[string]interface{}{"removed": err == nil, "preservedBranch": removed.PreservedBranch}, true, err
	case "projectGroup.create":
		var request runtimecore.CreateProjectGroupRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid project group create parameters")
		}
		group, err := s.manager.CreateProjectGroup(request)
		return map[string]interface{}{"group": group}, true, err
	case "projectGroup.update":
		var request struct {
			GroupID string                                `json:"groupId"`
			Updates runtimecore.UpdateProjectGroupRequest `json:"updates"`
		}
		if json.Unmarshal(raw, &request) != nil || strings.TrimSpace(request.GroupID) == "" {
			return nil, true, errors.New("invalid project group update parameters")
		}
		group, err := s.manager.UpdateProjectGroup(request.GroupID, request.Updates)
		return map[string]interface{}{"group": group}, true, err
	case "projectGroup.delete":
		id := readLegacyWorkspaceMutationID(raw, "groupId")
		if id == "" {
			return nil, true, errors.New("project group id is required")
		}
		deleted, err := s.manager.DeleteProjectGroup(id)
		return deleted, true, err
	case "projectGroup.moveProject":
		var request runtimecore.MoveProjectToGroupRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid project move parameters")
		}
		project, err := s.manager.MoveProjectToGroup(request)
		return map[string]interface{}{"repo": runtimeRPCProject(project)}, true, err
	case "folderWorkspace.create":
		var request runtimecore.CreateFolderWorkspaceRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid folder workspace create parameters")
		}
		workspace, err := s.manager.CreateFolderWorkspace(request)
		return map[string]interface{}{"folderWorkspace": workspace}, true, err
	case "folderWorkspace.update":
		var request struct {
			FolderWorkspaceID string                            `json:"folderWorkspaceId"`
			Updates           runtimecore.FolderWorkspaceUpdate `json:"updates"`
		}
		if json.Unmarshal(raw, &request) != nil || strings.TrimSpace(request.FolderWorkspaceID) == "" {
			return nil, true, errors.New("invalid folder workspace update parameters")
		}
		workspace, found, err := s.manager.UpdateFolderWorkspace(request.FolderWorkspaceID, request.Updates)
		if err != nil {
			return nil, true, err
		}
		if !found {
			return nil, true, runtimecore.ErrNotFound
		}
		return map[string]interface{}{"folderWorkspace": workspace}, true, nil
	case "folderWorkspace.delete":
		id := readLegacyWorkspaceMutationID(raw, "folderWorkspaceId")
		if id == "" {
			return nil, true, errors.New("folder workspace id is required")
		}
		deleted, err := s.manager.DeleteFolderWorkspace(id)
		return map[string]interface{}{"deleted": deleted}, true, err
	case "folderWorkspace.getPathStatus":
		var request runtimecore.FolderWorkspacePathStatusRequest
		if json.Unmarshal(raw, &request) != nil {
			return nil, true, errors.New("invalid folder workspace path parameters")
		}
		return map[string]interface{}{"status": s.manager.GetFolderWorkspacePathStatus(request)}, true, nil
	default:
		return nil, false, nil
	}
}

func (s *Server) createLegacySharedControlWorktree(raw json.RawMessage) (interface{}, bool, error) {
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil {
		return nil, true, errors.New("invalid worktree create parameters")
	}
	var repoSelector, name, base, branch string
	var startupCommand, startupAgent, startupPrompt, startupDraft, createdWithAgent string
	var startupEnvironment map[string]string
	var pasteDraftAfterReady bool
	var draftReadySignal string
	var setupDecision string
	var runHooks bool
	_ = json.Unmarshal(values["repo"], &repoSelector)
	_ = json.Unmarshal(values["name"], &name)
	_ = json.Unmarshal(values["baseBranch"], &base)
	_ = json.Unmarshal(values["branchNameOverride"], &branch)
	_ = json.Unmarshal(values["setupDecision"], &setupDecision)
	_ = json.Unmarshal(values["runHooks"], &runHooks)
	_ = json.Unmarshal(values["startupCommand"], &startupCommand)
	_ = json.Unmarshal(values["startupAgent"], &startupAgent)
	_ = json.Unmarshal(values["startupPrompt"], &startupPrompt)
	_ = json.Unmarshal(values["startupDraft"], &startupDraft)
	_ = json.Unmarshal(values["createdWithAgent"], &createdWithAgent)
	_ = json.Unmarshal(values["startupEnv"], &startupEnvironment)
	if startupEnvironment == nil {
		startupEnvironment = make(map[string]string)
	}
	if strings.TrimSpace(startupDraft) != "" {
		draftAgent := firstNonEmpty(startupAgent, createdWithAgent)
		plan, found := builtinAgentDraftStartup(draftAgent, startupDraft)
		if !found {
			return nil, true, errors.New("startup draft requires a supported startup agent")
		}
		startupCommand = plan.Command
		for key, value := range plan.Environment {
			startupEnvironment[key] = value
		}
		pasteDraftAfterReady = plan.PasteAfterReady
		draftReadySignal = plan.ReadySignal
		startupAgent = draftAgent
	}
	if startupAgent != "" && strings.TrimSpace(startupCommand) == "" {
		var found bool
		startupCommand, found = builtinAgentStartupCommand(startupAgent, startupPrompt)
		if !found {
			return nil, true, errors.New("unknown startup agent: " + startupAgent)
		}
	}
	project, found := s.findLegacySharedControlProject(repoSelector)
	if !found {
		return nil, true, runtimecore.ErrNotFound
	}
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\") {
		return nil, true, errors.New("worktree name must be one path segment")
	}
	if branch == "" {
		branch = name
	}
	var provenanceRequest runtimecore.AutomationWorkspaceProvenanceRequest
	var provenance *runtimecore.AutomationWorkspaceProvenance
	if provenanceRaw, exists := values["automationProvenanceRequest"]; exists && string(provenanceRaw) != "null" {
		if json.Unmarshal(provenanceRaw, &provenanceRequest) != nil {
			return nil, true, errors.New("invalid automation provenance parameters")
		}
		resolved, resolveErr := s.manager.BeginAutomationWorkspaceProvenance(provenanceRequest, project.ID)
		if resolveErr != nil {
			return nil, true, resolveErr
		}
		provenance = &resolved
		defer func() {
			if provenance != nil {
				s.manager.ReleaseAutomationWorkspaceProvenance(provenanceRequest)
			}
		}()
	}
	parentPath := project.WorktreeBasePath
	if parentPath == "" {
		parentPath = project.Path
	}
	created, err := s.manager.CreateWorktree(context.Background(), runtimecore.CreateWorktreeRequest{
		ProjectID: project.ID, Path: filepath.Join(parentPath, name), Branch: branch,
		Base: base, ExecuteGit: true,
	})
	if err != nil {
		return nil, true, err
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = s.manager.DeleteWorktree(context.Background(), created.ID, runtimecore.DeleteWorktreeRequest{
				ExecuteGit: true, Force: true, ForceBranchDelete: true, SkipArchiveHook: true,
			})
		}
	}()
	if sparseRaw, exists := values["sparseCheckout"]; exists && string(sparseRaw) != "null" {
		var sparse struct {
			Directories []string `json:"directories"`
			PresetID    string   `json:"presetId"`
		}
		if json.Unmarshal(sparseRaw, &sparse) != nil {
			return nil, true, errors.New("invalid sparse checkout parameters")
		}
		created, err = s.manager.ConfigureWorktreeSparseCheckout(context.Background(), created.ID, sparse.Directories, sparse.PresetID)
		if err != nil {
			return nil, true, err
		}
	}
	delete(values, "repo")
	delete(values, "name")
	delete(values, "baseBranch")
	delete(values, "compareBaseRef")
	delete(values, "branchNameOverride")
	delete(values, "sparseCheckout")
	delete(values, "telemetrySource")
	delete(values, "activate")
	delete(values, "setupDecision")
	delete(values, "runHooks")
	delete(values, "createdWithAgent")
	delete(values, "startupLaunchConfig")
	delete(values, "startupCommandDelivery")
	delete(values, "startupEnv")
	delete(values, "startupPrompt")
	delete(values, "startupDraft")
	delete(values, "automationProvenanceRequest")
	delete(values, "envParentWorkspace")
	delete(values, "cwdParentWorktree")
	delete(values, "callerTerminalHandle")
	delete(values, "orchestrationContext")
	if parent, exists := values["parentWorktree"]; exists {
		values["parentWorktreeId"] = parent
		delete(values, "parentWorktree")
	}
	encoded, _ := json.Marshal(values)
	var update runtimecore.UpdateWorktreeRequest
	if json.Unmarshal(encoded, &update) != nil {
		return nil, true, errors.New("invalid worktree create metadata")
	}
	if createdWithAgent == "" {
		createdWithAgent = startupAgent
	}
	if createdWithAgent != "" {
		update.CreatedWithAgent = &createdWithAgent
	}
	update.AutomationProvenance = provenance
	created, err = s.manager.UpdateWorktree(created.ID, update)
	if err != nil {
		return nil, true, err
	}
	committed = true
	if provenance != nil {
		s.manager.FinishAutomationWorkspaceProvenance(provenanceRequest)
		provenance = nil
	}
	result := runtimeRPCWorktreeCreateResult(created, s.manager.ListWorktreeLineage())
	setupScript := runtimecore.LoadWorktreeSetupHookScript(created.Path)
	shouldRunSetup := runHooks || setupDecision == "run"
	if setupScript != "" && shouldRunSetup {
		if err := runtimecore.RunWorktreeSetupHookOnHost(context.Background(), project.Path, created.Path); err != nil {
			result["warning"] = err.Error()
		}
	} else if setupScript != "" && setupDecision != "skip" {
		result["warning"] = "pebble.yaml setup hook skipped; pass setupDecision=run to run it"
	}
	if strings.TrimSpace(startupCommand) != "" {
		environment := make([]string, 0, len(startupEnvironment))
		keys := make([]string, 0, len(startupEnvironment))
		for key := range startupEnvironment {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			environment = append(environment, key+"="+startupEnvironment[key])
		}
		session, err := s.manager.StartSession(context.Background(), runtimecore.StartSessionRequest{
			ProjectID: project.ID, WorktreeID: created.ID, Cwd: created.Path,
			Prompt: startupCommand, AgentKind: startupAgent, Environment: environment,
		})
		if err != nil {
			result["warning"] = appendLegacyWorkspaceWarning(result["warning"], "startup terminal failed: "+err.Error())
		} else {
			result["startupTerminal"] = map[string]interface{}{
				"spawned": true, "handle": session.ID, "surface": "background",
			}
			if pasteDraftAfterReady {
				// Why: draft delivery is intentionally asynchronous; workspace creation
				// must not block for a slow TUI, and the write never includes Enter.
				go func() {
					_ = s.manager.PasteSessionDraftWhenReady(context.Background(), session.ID, startupDraft, draftReadySignal)
				}()
			}
		}
	}
	return result, true, nil
}

func appendLegacyWorkspaceWarning(existing interface{}, next string) string {
	if current, ok := existing.(string); ok && current != "" {
		return current + " " + next
	}
	return next
}

func (s *Server) findLegacySharedControlProject(selector string) (runtimecore.Project, bool) {
	selector = strings.TrimSpace(strings.TrimPrefix(selector, "id:"))
	for _, project := range s.manager.ListProjects() {
		if project.ID == selector || project.Path == selector {
			return project, true
		}
	}
	return runtimecore.Project{}, false
}

func (s *Server) findLegacySharedControlWorktree(selector string) (runtimecore.Worktree, bool) {
	selector = strings.TrimSpace(strings.TrimPrefix(selector, "id:"))
	for _, worktree := range s.manager.ListWorktrees("") {
		if worktree.ID == selector || worktree.Path == selector {
			return worktree, true
		}
	}
	return runtimecore.Worktree{}, false
}

func (s *Server) updateLegacySharedControlProject(raw json.RawMessage) (interface{}, bool, error) {
	var request struct {
		Repo    string                     `json:"repo"`
		Updates map[string]json.RawMessage `json:"updates"`
	}
	if json.Unmarshal(raw, &request) != nil {
		return nil, true, errors.New("invalid repository update parameters")
	}
	project, found := s.findLegacySharedControlProject(request.Repo)
	if !found {
		return nil, true, runtimecore.ErrNotFound
	}
	allowed := map[string]bool{"displayName": true, "worktreeBasePath": true, "issueSourcePreference": true, "projectGroupId": true, "projectGroupOrder": true}
	for field := range request.Updates {
		if !allowed[field] {
			return nil, true, errors.New("repository update field is not migrated: " + field)
		}
	}
	var update runtimecore.UpdateProjectRequest
	_ = json.Unmarshal(request.Updates["displayName"], &update.Name)
	decodeOptionalJSONString(request.Updates["worktreeBasePath"], &update.WorktreeBasePath)
	decodeOptionalJSONString(request.Updates["issueSourcePreference"], &update.IssueSourcePreference)
	updated, err := s.manager.UpdateProject(project.ID, update)
	if err != nil {
		return nil, true, err
	}
	if groupRaw, exists := request.Updates["projectGroupId"]; exists {
		var groupID *string
		if json.Unmarshal(groupRaw, &groupID) != nil {
			return nil, true, errors.New("invalid project group id")
		}
		var order *float64
		if rawOrder, ok := request.Updates["projectGroupOrder"]; ok {
			_ = json.Unmarshal(rawOrder, &order)
		}
		updated, err = s.manager.MoveProjectToGroup(runtimecore.MoveProjectToGroupRequest{ProjectID: project.ID, GroupID: groupID, Order: order})
		if err != nil {
			return nil, true, err
		}
	}
	return map[string]interface{}{"repo": runtimeRPCProject(updated)}, true, nil
}

func (s *Server) updateLegacySharedControlWorktree(raw json.RawMessage) (interface{}, bool, error) {
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil {
		return nil, true, errors.New("invalid worktree update parameters")
	}
	var selector string
	_ = json.Unmarshal(values["worktree"], &selector)
	worktree, found := s.findLegacySharedControlWorktree(selector)
	if !found {
		return nil, true, runtimecore.ErrNotFound
	}
	delete(values, "worktree")
	if parent, exists := values["parentWorktree"]; exists {
		values["parentWorktreeId"] = parent
		delete(values, "parentWorktree")
	}
	encoded, _ := json.Marshal(values)
	var update runtimecore.UpdateWorktreeRequest
	if json.Unmarshal(encoded, &update) != nil {
		return nil, true, errors.New("invalid worktree metadata")
	}
	updated, err := s.manager.UpdateWorktree(worktree.ID, update)
	return map[string]interface{}{"worktree": runtimeRPCWorktree(updated)}, true, err
}

func decodeOptionalJSONString(raw json.RawMessage, target **string) {
	if raw == nil {
		return
	}
	var value *string
	if json.Unmarshal(raw, &value) == nil {
		*target = value
	}
}

func readLegacyWorkspaceMutationID(raw json.RawMessage, key string) string {
	var values map[string]interface{}
	if json.Unmarshal(raw, &values) != nil {
		return ""
	}
	value, _ := values[key].(string)
	return strings.TrimSpace(value)
}

func readLegacyWorkspaceProjectSelector(raw json.RawMessage) string {
	var values struct {
		Repo      string `json:"repo"`
		RepoID    string `json:"repoId"`
		ProjectID string `json:"projectId"`
	}
	if json.Unmarshal(raw, &values) != nil {
		return ""
	}
	return firstNonEmpty(strings.TrimSpace(values.Repo), strings.TrimSpace(values.RepoID), strings.TrimSpace(values.ProjectID))
}
