package runtimecore

import "errors"

var (
	ErrInvalidPath      = errors.New("invalid path")
	ErrNotFound         = errors.New("not found")
	ErrProjectRequired  = errors.New("project id is required")
	ErrSessionNotFound  = errors.New("session not found")
	ErrBranchNotFound   = errors.New("local branch not found")
	ErrRemoteNeedsRelay = errors.New("remote project access requires relay transport")
)
