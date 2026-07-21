package runtimecore

// BrowserDriverState mirrors the renderer presence-lock contract for a native
// browser page. It is live process state and is intentionally not persisted.
type BrowserDriverState struct {
	Kind     string `json:"kind"`
	ClientID string `json:"clientId,omitempty"`
}

func (m *Manager) GetBrowserDriver(browserPageID string) BrowserDriverState {
	m.mu.RLock()
	driver, ok := m.browserDrivers[browserPageID]
	m.mu.RUnlock()
	if !ok {
		return BrowserDriverState{Kind: "idle"}
	}
	return driver
}

func (m *Manager) GetAllBrowserDrivers() map[string]BrowserDriverState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	drivers := make(map[string]BrowserDriverState, len(m.browserDrivers))
	for pageID, driver := range m.browserDrivers {
		drivers[pageID] = driver
	}
	return drivers
}

func (m *Manager) MobileTookBrowserFloor(browserPageID, clientID string) {
	m.setBrowserDriver(browserPageID, BrowserDriverState{Kind: "mobile", ClientID: clientID})
}

func (m *Manager) ReclaimBrowserForDesktop(browserPageID string) (bool, error) {
	m.mu.RLock()
	_, exists := m.browserTabs[browserPageID]
	m.mu.RUnlock()
	if !exists {
		return false, ErrNotFound
	}
	previous := m.GetBrowserDriver(browserPageID)
	m.setBrowserDriver(browserPageID, BrowserDriverState{Kind: "desktop"})
	return previous.Kind == "mobile", nil
}

func (m *Manager) ReleaseMobileBrowserFloor(browserPageID, clientID string) {
	current := m.GetBrowserDriver(browserPageID)
	if current.Kind == "mobile" && current.ClientID == clientID {
		m.setBrowserDriver(browserPageID, BrowserDriverState{Kind: "idle"})
	}
}

func (m *Manager) setBrowserDriver(browserPageID string, driver BrowserDriverState) {
	m.mu.Lock()
	previous := m.browserDrivers[browserPageID]
	changed := previous != driver
	if changed {
		if driver.Kind == "idle" {
			delete(m.browserDrivers, browserPageID)
		} else {
			m.browserDrivers[browserPageID] = driver
		}
	}
	m.mu.Unlock()
	if changed {
		m.emit("browser.driver", map[string]interface{}{
			"browserPageId": browserPageID,
			"driver":        driver,
		})
	}
}
