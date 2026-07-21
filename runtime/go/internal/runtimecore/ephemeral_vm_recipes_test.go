package runtimecore

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestReadEphemeralVMRecipesNormalizesDestroyNoneAndDiagnostics(t *testing.T) {
	repo := t.TempDir()
	content := `environmentRecipes:
  - id: cloud
    name: Cloud VM
    create: ./start.sh
    destroy: none
  - id: cloud
    name: Duplicate
    create: ./duplicate.sh
`
	if err := os.WriteFile(filepath.Join(repo, "pebble.yaml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	recipes, diagnostics := readEphemeralVMRecipes(repo)
	if len(recipes) != 1 || recipes[0].ID != "cloud" || !recipes[0].DestroyDisabled {
		t.Fatalf("unexpected recipes: %#v", recipes)
	}
	if len(diagnostics) != 1 || diagnostics[0].Index != 1 {
		t.Fatalf("unexpected diagnostics: %#v", diagnostics)
	}
}

func TestDoctorCommandChecksRepoRelativeExecutable(t *testing.T) {
	repo := t.TempDir()
	script := filepath.Join(repo, "start.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	check := doctorCommand(repo, "./start.sh --provider test", "recipe.create")
	if runtime.GOOS == "windows" && check.Status != "pass" {
		t.Fatalf("Windows should accept an existing script: %#v", check)
	}
	if runtime.GOOS != "windows" && check.Status != "pass" {
		t.Fatalf("expected executable script to pass: %#v", check)
	}
	missing := doctorCommand(repo, "./missing.sh", "recipe.create")
	if missing.Status != "fail" {
		t.Fatalf("missing script must fail: %#v", missing)
	}
}
