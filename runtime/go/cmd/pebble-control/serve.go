package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const sharedControlPath = "/v1/shared-control"

type serveOptions struct {
	port           int
	pairingAddress string
	noPairing      bool
	mobilePairing  bool
	recipeJSON     bool
	projectRoot    string
	jsonOutput     bool
}

type pairingMaterial struct {
	DeviceToken  string `json:"deviceToken"`
	PublicKeyB64 string `json:"publicKeyB64"`
}

type pairingOffer struct {
	Version      int    `json:"v"`
	Endpoint     string `json:"endpoint"`
	DeviceToken  string `json:"deviceToken"`
	PublicKeyB64 string `json:"publicKeyB64"`
	Scope        string `json:"scope"`
}

type serveResult struct {
	Endpoint      string `json:"endpoint,omitempty"`
	PairingCode   string `json:"pairingCode,omitempty"`
	ProjectRoot   string `json:"projectRoot,omitempty"`
	SchemaVersion int    `json:"schemaVersion,omitempty"`
}

func runServe(args []string, token string, output, errorOutput io.Writer) error {
	options, err := parseServeOptions(args)
	if err != nil {
		return err
	}
	port := options.port
	if port == 0 {
		port, err = reserveLoopbackPort()
		if err != nil {
			return fmt.Errorf("choose runtime port: %w", err)
		}
	}
	listen := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	runtimeHTTP := "http://" + listen
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	token = strings.TrimSpace(token)
	command, err := runtimeCommand(ctx, listen)
	if err != nil {
		return err
	}
	command.Stdin = os.Stdin
	command.Stdout = io.Discard
	command.Stderr = errorOutput
	if token != "" {
		// Why: bearer tokens must stay out of argv/process listings while the
		// control process and runtime agree on the same authenticated endpoint.
		command.Env = append(os.Environ(), "PEBBLE_RUNTIME_TOKEN="+token)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("start Pebble runtime: %w", err)
	}
	wait := make(chan error, 1)
	go func() { wait <- command.Wait() }()
	client := &http.Client{Timeout: 500 * time.Millisecond}
	if err := waitForRuntime(ctx, client, runtimeHTTP, token, wait); err != nil {
		stop()
		<-wait
		return err
	}

	result := serveResult{Endpoint: runtimeHTTP}
	if !options.noPairing {
		scope := "runtime"
		if options.mobilePairing {
			scope = "mobile"
		}
		material, err := requestPairing(client, runtimeHTTP, token, scope)
		if err != nil {
			stop()
			<-wait
			return err
		}
		endpoint, err := sharedControlEndpoint(options.pairingAddress, port)
		if err != nil {
			stop()
			<-wait
			return err
		}
		result.PairingCode, err = encodePairingOffer(pairingOffer{
			Version: 2, Endpoint: endpoint, DeviceToken: material.DeviceToken,
			PublicKeyB64: material.PublicKeyB64, Scope: scope,
		})
		if err != nil {
			stop()
			<-wait
			return err
		}
	}
	if options.recipeJSON {
		recipe := struct {
			SchemaVersion int    `json:"schemaVersion"`
			PairingCode   string `json:"pairingCode"`
			ProjectRoot   string `json:"projectRoot"`
		}{SchemaVersion: 1, PairingCode: result.PairingCode, ProjectRoot: options.projectRoot}
		if err := json.NewEncoder(output).Encode(recipe); err != nil {
			stop()
			<-wait
			return err
		}
	} else if options.jsonOutput {
		if err := json.NewEncoder(output).Encode(result); err != nil {
			stop()
			<-wait
			return err
		}
	} else {
		fmt.Fprintf(output, "Pebble runtime listening on %s\n", runtimeHTTP)
		if result.PairingCode != "" {
			fmt.Fprintf(output, "Pairing URL: %s\n", result.PairingCode)
		}
	}
	return <-wait
}

func parseServeOptions(args []string) (serveOptions, error) {
	options := serveOptions{port: 17777}
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.IntVar(&options.port, "port", 17777, "runtime listen port")
	flags.StringVar(&options.pairingAddress, "pairing-address", "", "client-visible host or WebSocket URL")
	flags.BoolVar(&options.noPairing, "no-pairing", false, "disable pairing output")
	flags.BoolVar(&options.mobilePairing, "mobile-pairing", false, "create a mobile-scoped pairing")
	flags.BoolVar(&options.recipeJSON, "recipe-json", false, "print one workspace recipe JSON object")
	flags.StringVar(&options.projectRoot, "project-root", "", "absolute workspace project root")
	flags.BoolVar(&options.jsonOutput, "json", false, "print structured JSON")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	if flags.NArg() != 0 {
		return options, fmt.Errorf("unexpected serve argument %q", flags.Arg(0))
	}
	if options.port < 0 || options.port > 65535 {
		return options, fmt.Errorf("invalid --port value: %d", options.port)
	}
	if options.noPairing && options.mobilePairing {
		return options, errors.New("use either --mobile-pairing or --no-pairing, not both")
	}
	if options.recipeJSON && options.noPairing {
		return options, errors.New("recipe JSON output requires runtime pairing; remove --no-pairing")
	}
	if options.recipeJSON && options.mobilePairing {
		return options, errors.New("recipe JSON output requires runtime pairing; remove --mobile-pairing")
	}
	if options.recipeJSON {
		root := strings.TrimSpace(options.projectRoot)
		if root == "" {
			return options, errors.New("recipe JSON output requires --project-root")
		}
		if !filepath.IsAbs(root) {
			return options, errors.New("--project-root must be an absolute path")
		}
		options.projectRoot = filepath.Clean(root)
	}
	return options, nil
}

func runtimeCommand(ctx context.Context, listen string) (*exec.Cmd, error) {
	if executable, err := os.Executable(); err == nil {
		for _, candidate := range siblingRuntimeCandidates(executable) {
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				return exec.CommandContext(ctx, candidate, "--listen", listen), nil
			}
		}
	}
	root := findGoRoot()
	if root == "" {
		return nil, errors.New("could not locate the bundled pebble-runtime executable")
	}
	command := exec.CommandContext(ctx, "go", "run", "./cmd/pebble-runtime", "--listen", listen)
	command.Dir = root
	return command, nil
}

func siblingRuntimeCandidates(controlExecutable string) []string {
	directory := filepath.Dir(controlExecutable)
	candidates := []string{filepath.Join(directory, platformBinaryName("pebble-runtime"))}
	base := filepath.Base(controlExecutable)
	extension := filepath.Ext(base)
	stem := strings.TrimSuffix(base, extension)
	if suffix := strings.TrimPrefix(stem, "pebble-control-"); suffix != stem && suffix != "" {
		candidates = append(candidates, filepath.Join(directory, "pebble-runtime-"+suffix+extension))
	}
	return candidates
}

func findGoRoot() string {
	starts := []string{}
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	for _, start := range starts {
		for current := start; ; current = filepath.Dir(current) {
			candidate := filepath.Join(current, "runtime", "go", "cmd", "pebble-runtime")
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				return filepath.Join(current, "runtime", "go")
			}
			parent := filepath.Dir(current)
			if parent == current {
				break
			}
		}
	}
	return ""
}

func platformBinaryName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func reserveLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func waitForRuntime(ctx context.Context, client *http.Client, endpoint, token string, wait chan error) error {
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"/v1/status", nil)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		if response, err := client.Do(request); err == nil {
			_ = response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				return nil
			}
		}
		select {
		case err := <-wait:
			wait <- err
			if err == nil {
				return errors.New("Pebble runtime exited before becoming ready")
			}
			return fmt.Errorf("Pebble runtime exited before becoming ready: %w", err)
		case <-deadline.C:
			return errors.New("timed out waiting for Pebble runtime")
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func requestPairing(client *http.Client, endpoint, token, scope string) (pairingMaterial, error) {
	body, _ := json.Marshal(map[string]interface{}{
		"name": "Pebble CLI", "scope": scope, "rotate": false,
	})
	request, err := http.NewRequest(http.MethodPost, endpoint+"/v1/shared-control/pairing", bytes.NewReader(body))
	if err != nil {
		return pairingMaterial{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return pairingMaterial{}, fmt.Errorf("create runtime pairing: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		content, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return pairingMaterial{}, fmt.Errorf("create runtime pairing: HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(content)))
	}
	var material pairingMaterial
	if err := json.NewDecoder(response.Body).Decode(&material); err != nil {
		return pairingMaterial{}, fmt.Errorf("decode runtime pairing: %w", err)
	}
	if material.DeviceToken == "" || material.PublicKeyB64 == "" {
		return pairingMaterial{}, errors.New("runtime returned incomplete pairing material")
	}
	return material, nil
}

func sharedControlEndpoint(address string, port int) (string, error) {
	address = strings.TrimSpace(address)
	if address == "" {
		address = "127.0.0.1"
	}
	if strings.Contains(address, "://") {
		parsed, err := url.Parse(address)
		if err != nil || parsed.Host == "" {
			return "", fmt.Errorf("invalid --pairing-address value: %s", address)
		}
		switch parsed.Scheme {
		case "http":
			parsed.Scheme = "ws"
		case "https":
			parsed.Scheme = "wss"
		case "ws", "wss":
		default:
			return "", fmt.Errorf("unsupported pairing address scheme %q", parsed.Scheme)
		}
		if parsed.Path == "" || parsed.Path == "/" {
			parsed.Path = sharedControlPath
		}
		return parsed.String(), nil
	}
	host := address
	if parsedIP := net.ParseIP(strings.Trim(address, "[]")); parsedIP != nil && strings.Contains(address, ":") {
		host = "[" + strings.Trim(address, "[]") + "]"
	}
	if _, _, err := net.SplitHostPort(host); err != nil {
		host = net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port))
	}
	return "ws://" + host + sharedControlPath, nil
}

func encodePairingOffer(offer pairingOffer) (string, error) {
	encoded, err := json.Marshal(offer)
	if err != nil {
		return "", err
	}
	return "pebble://pair?code=" + base64.RawURLEncoding.EncodeToString(encoded), nil
}
