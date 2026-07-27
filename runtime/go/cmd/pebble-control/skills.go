package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"sort"
	"strings"
)

type skillGuideResult struct {
	Name                string `json:"name"`
	RequestedAppVersion string `json:"requestedAppVersion"`
	ResolvedAppVersion  string `json:"resolvedAppVersion"`
	ReleaseRevision     int    `json:"releaseRevision"`
	FallbackReason      string `json:"fallbackReason,omitempty"`
	Content             string `json:"content"`
}

func runSkills(args []string, output io.Writer) error {
	if len(args) == 0 || args[0] != "get" {
		return fmt.Errorf("usage: pebble skills get [--app-version VERSION] [--json] <skill-name>")
	}
	flags := flag.NewFlagSet("skills get", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	appVersion := flags.String("app-version", bundledSkillAppVersion, "Pebble application version")
	jsonOutput := flags.Bool("json", false, "print structured JSON")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 1 {
		return fmt.Errorf("skills get requires exactly one skill name")
	}
	name := strings.TrimSpace(flags.Arg(0))
	guide, found := bundledSkillGuides[name]
	if !found {
		names := make([]string, 0, len(bundledSkillGuides))
		for candidate := range bundledSkillGuides {
			names = append(names, candidate)
		}
		sort.Strings(names)
		return fmt.Errorf("unknown skill %q; available skills: %s", name, strings.Join(names, ", "))
	}
	requestedVersion := strings.TrimSpace(*appVersion)
	if requestedVersion == "" {
		requestedVersion = bundledSkillAppVersion
	}
	result := skillGuideResult{
		Name: name, RequestedAppVersion: requestedVersion,
		ResolvedAppVersion: bundledSkillAppVersion, ReleaseRevision: guide.Revision,
		Content: guide.Content,
	}
	if requestedVersion != bundledSkillAppVersion {
		// Why: a bundled guide is safer than guessing commands when a development
		// build has no explicit historical mapping yet.
		result.FallbackReason = "requested version is unmapped; using the current bundled guide"
	}
	if *jsonOutput {
		return json.NewEncoder(output).Encode(result)
	}
	_, err := io.WriteString(output, result.Content)
	return err
}
