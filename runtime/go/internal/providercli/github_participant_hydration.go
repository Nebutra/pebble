package providercli

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

const githubParticipantHydrationLimit = 50

func hydrateGitHubParticipants(ctx context.Context, workdir string, participants []GitHubAssignableUser) []GitHubAssignableUser {
	if len(participants) == 0 {
		return participants
	}
	byLogin := make(map[string]GitHubAssignableUser, len(participants))
	logins := make([]string, 0, len(participants))
	for _, participant := range participants {
		login := strings.TrimSpace(participant.Login)
		key := strings.ToLower(login)
		if login == "" || key == "" {
			continue
		}
		if _, exists := byLogin[key]; !exists {
			logins = append(logins, login)
		}
		byLogin[key] = participant
	}
	sort.Strings(logins)
	allLogins := append([]string(nil), logins...)
	if len(logins) > githubParticipantHydrationLimit {
		logins = logins[:githubParticipantHydrationLimit]
	}
	fields := make([]string, 0, len(logins))
	for index, login := range logins {
		fields = append(fields, fmt.Sprintf("u%d: user(login:%s) { login name avatarUrl(size:48) }", index, strconv.Quote(login)))
	}
	query := "query { " + strings.Join(fields, " ") + " }"
	out, err := runCLI(ctx, "gh", workdir, "api", "graphql", "-f", "query="+query)
	if err != nil {
		return participants
	}
	var payload struct {
		Data map[string]*struct {
			Login     string  `json:"login"`
			Name      *string `json:"name"`
			AvatarURL string  `json:"avatarUrl"`
		} `json:"data"`
	}
	if json.Unmarshal(out, &payload) != nil {
		return participants
	}
	for _, user := range payload.Data {
		if user == nil || user.Login == "" {
			continue
		}
		key := strings.ToLower(user.Login)
		current, exists := byLogin[key]
		if !exists {
			continue
		}
		current.Name = user.Name
		if user.AvatarURL != "" {
			current.AvatarURL = user.AvatarURL
		}
		byLogin[key] = current
	}
	result := make([]GitHubAssignableUser, 0, len(byLogin))
	for _, login := range allLogins {
		result = append(result, byLogin[strings.ToLower(login)])
	}
	return result
}
