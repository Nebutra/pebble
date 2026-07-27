package runtimecore

import (
	"sync"
	"time"
)

// Sized past the default recency cap (1000) plus the in-scope parse budget
// (2000) so a full steady-state result set stays resident between rescans.
const aiVaultParseCacheMaxEntries = 4096

type aiVaultParseCacheEntry struct {
	modTime time.Time
	size    int64
	session *AiVaultSession
	err     error
}

// Why: AI Vault scans re-parse the same transcript files on every forced
// refresh (~5s). Reusing mtime+size-stable parses keeps the host process from
// re-reading gigabytes of agent history (upstream #7525 / STA-1278).
var aiVaultParseCache = struct {
	mu      sync.Mutex
	entries map[string]aiVaultParseCacheEntry
	order   []string
}{
	entries: make(map[string]aiVaultParseCacheEntry),
}

func resetAiVaultParseCacheForTests() {
	aiVaultParseCache.mu.Lock()
	defer aiVaultParseCache.mu.Unlock()
	aiVaultParseCache.entries = make(map[string]aiVaultParseCacheEntry)
	aiVaultParseCache.order = nil
}

func parseAiVaultCandidateCached(candidate aiVaultCandidate, codexHome string) (*AiVaultSession, error) {
	path := candidate.path
	modTime := candidate.info.ModTime()
	size := candidate.info.Size()

	aiVaultParseCache.mu.Lock()
	if entry, ok := aiVaultParseCache.entries[path]; ok &&
		entry.modTime.Equal(modTime) &&
		entry.size == size {
		// Touch LRU order so hot transcripts stay under the cap.
		touchAiVaultParseCacheLocked(path)
		session := cloneAiVaultSession(entry.session)
		err := entry.err
		aiVaultParseCache.mu.Unlock()
		return session, err
	}
	aiVaultParseCache.mu.Unlock()

	session, err := parseAiVaultCandidate(candidate, codexHome)

	aiVaultParseCache.mu.Lock()
	storeAiVaultParseCacheLocked(path, aiVaultParseCacheEntry{
		modTime: modTime,
		size:    size,
		session: cloneAiVaultSession(session),
		err:     err,
	})
	aiVaultParseCache.mu.Unlock()
	return session, err
}

func touchAiVaultParseCacheLocked(path string) {
	for index, key := range aiVaultParseCache.order {
		if key == path {
			aiVaultParseCache.order = append(aiVaultParseCache.order[:index], aiVaultParseCache.order[index+1:]...)
			break
		}
	}
	aiVaultParseCache.order = append(aiVaultParseCache.order, path)
}

func storeAiVaultParseCacheLocked(path string, entry aiVaultParseCacheEntry) {
	if _, exists := aiVaultParseCache.entries[path]; exists {
		touchAiVaultParseCacheLocked(path)
	} else {
		aiVaultParseCache.order = append(aiVaultParseCache.order, path)
	}
	aiVaultParseCache.entries[path] = entry
	for len(aiVaultParseCache.order) > aiVaultParseCacheMaxEntries {
		oldest := aiVaultParseCache.order[0]
		aiVaultParseCache.order = aiVaultParseCache.order[1:]
		delete(aiVaultParseCache.entries, oldest)
	}
}

func cloneAiVaultSession(session *AiVaultSession) *AiVaultSession {
	if session == nil {
		return nil
	}
	copySession := *session
	if session.Cwd != nil {
		cwd := *session.Cwd
		copySession.Cwd = &cwd
	}
	if session.Branch != nil {
		branch := *session.Branch
		copySession.Branch = &branch
	}
	if session.Model != nil {
		model := *session.Model
		copySession.Model = &model
	}
	if session.CodexHome != nil {
		home := *session.CodexHome
		copySession.CodexHome = &home
	}
	if session.CreatedAt != nil {
		created := *session.CreatedAt
		copySession.CreatedAt = &created
	}
	if session.UpdatedAt != nil {
		updated := *session.UpdatedAt
		copySession.UpdatedAt = &updated
	}
	if len(session.PreviewMessages) > 0 {
		copySession.PreviewMessages = append([]AiVaultPreviewMessage(nil), session.PreviewMessages...)
		for index := range copySession.PreviewMessages {
			if session.PreviewMessages[index].Timestamp != nil {
				stamp := *session.PreviewMessages[index].Timestamp
				copySession.PreviewMessages[index].Timestamp = &stamp
			}
		}
	}
	return &copySession
}
