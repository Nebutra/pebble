package runtimecore

import (
	"encoding/json"
	"io"
)

func encodeJSON(writer io.Writer, value any) error { return json.NewEncoder(writer).Encode(value) }

func decodeJSON(reader io.Reader, target any) error { return json.NewDecoder(reader).Decode(target) }
