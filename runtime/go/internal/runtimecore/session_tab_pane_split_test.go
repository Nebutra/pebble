package runtimecore

import "testing"

func TestReplaceSessionPaneLeafPreservesNestedSibling(t *testing.T) {
	root := map[string]interface{}{
		"type":      "split",
		"direction": "horizontal",
		"ratio":     0.4,
		"first":     map[string]interface{}{"type": "leaf", "leafId": "leaf-left"},
		"second":    map[string]interface{}{"type": "leaf", "leafId": "leaf-right"},
	}
	value, found := replaceSessionPaneLeaf(root, "leaf-right", "leaf-new", "vertical")
	if !found {
		t.Fatal("expected nested source leaf to be replaced")
	}
	outer := value.(map[string]interface{})
	if outer["ratio"] != 0.4 || outer["direction"] != "horizontal" {
		t.Fatalf("outer split metadata changed: %#v", outer)
	}
	inner := outer["second"].(map[string]interface{})
	if inner["type"] != "split" || inner["direction"] != "vertical" {
		t.Fatalf("unexpected nested split: %#v", inner)
	}
}
