package runtimecore

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

type EphemeralVMRecipe struct {
	ID              string `json:"id" yaml:"id"`
	Name            string `json:"name" yaml:"name"`
	Create          string `json:"create" yaml:"create"`
	Description     string `json:"description,omitempty" yaml:"description"`
	Suspend         string `json:"suspend,omitempty" yaml:"suspend"`
	Resume          string `json:"resume,omitempty" yaml:"resume"`
	Destroy         string `json:"destroy,omitempty" yaml:"destroy"`
	DestroyDisabled bool   `json:"destroyDisabled,omitempty" yaml:"-"`
}

type EphemeralVMRecipeDiagnostic struct {
	Index   int    `json:"index"`
	Field   string `json:"field,omitempty"`
	Message string `json:"message"`
}

type EphemeralVMRecipeList struct {
	Status      string                        `json:"status"`
	RepoPath    *string                       `json:"repoPath"`
	Recipes     []EphemeralVMRecipe           `json:"recipes"`
	Diagnostics []EphemeralVMRecipeDiagnostic `json:"diagnostics"`
	Message     string                        `json:"message,omitempty"`
}

type EphemeralVMRecipeCatalogEntry struct {
	RepoID      string                        `json:"repoId"`
	RepoName    string                        `json:"repoName"`
	RepoPath    string                        `json:"repoPath"`
	Recipes     []EphemeralVMRecipe           `json:"recipes"`
	Diagnostics []EphemeralVMRecipeDiagnostic `json:"diagnostics"`
}

type EphemeralVMDoctorCheck struct {
	ID          string `json:"id"`
	Status      string `json:"status"`
	Message     string `json:"message"`
	Remediation string `json:"remediation,omitempty"`
}

type EphemeralVMDoctorResult struct {
	RecipeID string                   `json:"recipeId"`
	RepoPath string                   `json:"repoPath"`
	OK       bool                     `json:"ok"`
	Checks   []EphemeralVMDoctorCheck `json:"checks"`
}

func (m *Manager) ListEphemeralVMRecipes(projectID string) EphemeralVMRecipeList {
	project, err := m.localGitProject(projectID)
	if err != nil {
		return EphemeralVMRecipeList{Status: "error", Recipes: []EphemeralVMRecipe{}, Diagnostics: []EphemeralVMRecipeDiagnostic{}, Message: err.Error()}
	}
	recipes, diagnostics := readEphemeralVMRecipes(project.Path)
	return EphemeralVMRecipeList{Status: "ok", RepoPath: &project.Path, Recipes: recipes, Diagnostics: diagnostics}
}

func (m *Manager) ListEphemeralVMRecipeCatalog() []EphemeralVMRecipeCatalogEntry {
	entries := make([]EphemeralVMRecipeCatalogEntry, 0)
	for _, project := range m.ListProjects() {
		if strings.TrimSpace(project.Path) == "" || strings.TrimSpace(project.HostID) != "" {
			continue
		}
		recipes, diagnostics := readEphemeralVMRecipes(project.Path)
		if len(recipes) == 0 && len(diagnostics) == 0 {
			continue
		}
		entries = append(entries, EphemeralVMRecipeCatalogEntry{RepoID: project.ID, RepoName: project.Name, RepoPath: project.Path, Recipes: recipes, Diagnostics: diagnostics})
	}
	sort.Slice(entries, func(i, j int) bool {
		return strings.ToLower(entries[i].RepoName) < strings.ToLower(entries[j].RepoName)
	})
	return entries
}

func (m *Manager) DoctorEphemeralVMRecipe(projectID, recipeID string) EphemeralVMDoctorResult {
	listed := m.ListEphemeralVMRecipes(projectID)
	path := ""
	if listed.RepoPath != nil {
		path = *listed.RepoPath
	}
	checks := []EphemeralVMDoctorCheck{}
	if listed.Status != "ok" {
		return doctorResult(recipeID, path, []EphemeralVMDoctorCheck{{ID: "repo.path", Status: "fail", Message: listed.Message, Remediation: "Use a local repository containing pebble.yaml."}})
	}
	var recipe *EphemeralVMRecipe
	for i := range listed.Recipes {
		if listed.Recipes[i].ID == recipeID {
			recipe = &listed.Recipes[i]
			break
		}
	}
	if recipe == nil {
		return doctorResult(recipeID, path, []EphemeralVMDoctorCheck{{ID: "recipe.exists", Status: "fail", Message: "Recipe \"" + recipeID + "\" was not found in environmentRecipes.", Remediation: "Check the recipe id or add it to environmentRecipes."}})
	}
	checks = append(checks, EphemeralVMDoctorCheck{ID: "recipe.exists", Status: "pass", Message: "Found recipe \"" + recipe.Name + "\"."})
	checks = append(checks, doctorCommand(path, recipe.Create, "recipe.create"))
	if recipe.DestroyDisabled {
		checks = append(checks, EphemeralVMDoctorCheck{ID: "recipe.destroy", Status: "warn", Message: "Destroy is explicitly disabled.", Remediation: "Only use destroy: none when provider resources are cleaned up elsewhere."})
	} else if recipe.Destroy != "" {
		checks = append(checks, doctorCommand(path, recipe.Destroy, "recipe.destroy"))
	} else {
		checks = append(checks, EphemeralVMDoctorCheck{ID: "recipe.destroy", Status: "warn", Message: "No destroy action is configured.", Remediation: "Add destroy or explicitly set destroy: none."})
	}
	if recipe.Suspend != "" {
		checks = append(checks, doctorCommand(path, recipe.Suspend, "recipe.suspend"))
	}
	if recipe.Resume != "" {
		checks = append(checks, doctorCommand(path, recipe.Resume, "recipe.resume"))
	}
	if (recipe.Suspend == "") != (recipe.Resume == "") {
		checks = append(checks, EphemeralVMDoctorCheck{ID: "recipe.suspend_resume_pairing", Status: "warn", Message: "Recipe defines only one of suspend/resume.", Remediation: "Define both so a suspended workspace can be resumed, or neither."})
	}
	return doctorResult(recipeID, path, checks)
}

func readEphemeralVMRecipes(repoPath string) ([]EphemeralVMRecipe, []EphemeralVMRecipeDiagnostic) {
	data, err := os.ReadFile(filepath.Join(repoPath, "pebble.yaml"))
	if errors.Is(err, os.ErrNotExist) {
		return []EphemeralVMRecipe{}, []EphemeralVMRecipeDiagnostic{}
	}
	if err != nil {
		return []EphemeralVMRecipe{}, []EphemeralVMRecipeDiagnostic{{Index: 0, Message: err.Error()}}
	}
	var raw struct {
		EnvironmentRecipes []map[string]interface{} `yaml:"environmentRecipes"`
	}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return []EphemeralVMRecipe{}, []EphemeralVMRecipeDiagnostic{{Index: 0, Message: "pebble.yaml is invalid: " + err.Error()}}
	}
	recipes := make([]EphemeralVMRecipe, 0, len(raw.EnvironmentRecipes))
	diagnostics := []EphemeralVMRecipeDiagnostic{}
	seen := map[string]bool{}
	for index, value := range raw.EnvironmentRecipes {
		id, _ := value["id"].(string)
		name, _ := value["name"].(string)
		create, _ := value["create"].(string)
		id, name, create = strings.TrimSpace(id), strings.TrimSpace(name), strings.TrimSpace(create)
		if id == "" || name == "" || create == "" || seen[id] {
			diagnostics = append(diagnostics, EphemeralVMRecipeDiagnostic{Index: index, Message: "Recipe requires unique non-empty id, name, and create fields."})
			continue
		}
		seen[id] = true
		recipe := EphemeralVMRecipe{ID: id, Name: name, Create: create}
		if text, ok := value["description"].(string); ok {
			recipe.Description = strings.TrimSpace(text)
		}
		if text, ok := value["suspend"].(string); ok {
			recipe.Suspend = strings.TrimSpace(text)
		}
		if text, ok := value["resume"].(string); ok {
			recipe.Resume = strings.TrimSpace(text)
		}
		if text, ok := value["destroy"].(string); ok {
			if strings.EqualFold(strings.TrimSpace(text), "none") {
				recipe.DestroyDisabled = true
			} else {
				recipe.Destroy = strings.TrimSpace(text)
			}
		}
		recipes = append(recipes, recipe)
	}
	return recipes, diagnostics
}

func doctorCommand(repoPath, command, id string) EphemeralVMDoctorCheck {
	token := firstCommandToken(command)
	if token == "" {
		return EphemeralVMDoctorCheck{ID: id, Status: "fail", Message: "Command is empty.", Remediation: "Set a repo-relative command path."}
	}
	if filepath.IsAbs(token) {
		return EphemeralVMDoctorCheck{ID: id, Status: "warn", Message: "Command uses an absolute path: " + token, Remediation: "Prefer a repo-relative script so the recipe works across machines."}
	}
	if !strings.HasPrefix(token, "./") && !strings.HasPrefix(token, `.\`) {
		return EphemeralVMDoctorCheck{ID: id, Status: "warn", Message: "Command is not a repo-relative path: " + token, Remediation: "Use a repo-relative script such as ./scripts/pebble-vm/start.sh."}
	}
	info, err := os.Stat(filepath.Join(repoPath, filepath.Clean(token)))
	if err != nil {
		return EphemeralVMDoctorCheck{ID: id, Status: "fail", Message: "Command path does not exist: " + token, Remediation: "Create the script or update the recipe command path."}
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return EphemeralVMDoctorCheck{ID: id, Status: "warn", Message: "Command exists but is not executable: " + token, Remediation: "Make it executable: chmod +x (git: git update-index --chmod=+x)."}
	}
	return EphemeralVMDoctorCheck{ID: id, Status: "pass", Message: "Command path exists: " + token}
}

func firstCommandToken(command string) string {
	fields := strings.Fields(strings.TrimSpace(command))
	if len(fields) == 0 {
		return ""
	}
	return strings.Trim(fields[0], `"'`)
}
func doctorResult(id, path string, checks []EphemeralVMDoctorCheck) EphemeralVMDoctorResult {
	ok := true
	for _, check := range checks {
		if check.Status == "fail" {
			ok = false
		}
	}
	return EphemeralVMDoctorResult{RecipeID: id, RepoPath: path, OK: ok, Checks: checks}
}
