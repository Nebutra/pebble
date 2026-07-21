package main

import (
	"context"
	"encoding/json"
	"io"
	"time"

	"github.com/nebutra/pebble/runtime/go/internal/runtimecore"
)

func runProviderTextGenerationJSON(input io.Reader, output io.Writer) error {
	var plan runtimecore.ProviderTextGenerationPlan
	if err := json.NewDecoder(io.LimitReader(input, 16*1024*1024)).Decode(&plan); err != nil {
		return err
	}
	// The parent runtime owns the outer SSH deadline; this inner bound ensures a
	// disconnected client can never leave an unbounded provider process behind.
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	plan.Target = runtimecore.ProviderTextGenerationTarget{Kind: "local"}
	return json.NewEncoder(output).Encode(runtimecore.ExecuteProviderTextGenerationPlan(ctx, plan))
}
