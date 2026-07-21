package runtimecore

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"golang.org/x/crypto/nacl/box"
)

type LegacySharedControlKeypair struct {
	PublicKeyB64 string `json:"publicKeyB64"`
	SecretKeyB64 string `json:"secretKeyB64"`
}

type LegacySharedControlDevice struct {
	DeviceID   string `json:"deviceId"`
	Name       string `json:"name"`
	Token      string `json:"token"`
	Scope      string `json:"scope"`
	PairedAt   int64  `json:"pairedAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
}

type LegacySharedControlState struct {
	Keypair LegacySharedControlKeypair  `json:"keypair"`
	Devices []LegacySharedControlDevice `json:"devices"`
}

type LegacySharedControlPairingMaterial struct {
	DeviceID     string `json:"deviceId"`
	DeviceToken  string `json:"deviceToken"`
	PublicKeyB64 string `json:"publicKeyB64"`
	Scope        string `json:"scope"`
}

func (m *Manager) EnsureLegacySharedControlIdentity() (LegacySharedControlKeypair, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if validLegacySharedControlKeypair(m.legacySharedControl.Keypair) {
		return m.legacySharedControl.Keypair, nil
	}
	publicKey, secretKey, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return LegacySharedControlKeypair{}, err
	}
	m.legacySharedControl.Keypair = LegacySharedControlKeypair{
		PublicKeyB64: base64.StdEncoding.EncodeToString(publicKey[:]),
		SecretKeyB64: base64.StdEncoding.EncodeToString(secretKey[:]),
	}
	if err := m.saveLocked(); err != nil {
		return LegacySharedControlKeypair{}, err
	}
	return m.legacySharedControl.Keypair, nil
}

func (m *Manager) CreateLegacySharedControlPairing(name, scope string, rotate bool) (LegacySharedControlPairingMaterial, error) {
	keypair, err := m.EnsureLegacySharedControlIdentity()
	if err != nil {
		return LegacySharedControlPairingMaterial{}, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Pebble client"
	}
	if scope != "mobile" {
		scope = "runtime"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if rotate {
		filtered := m.legacySharedControl.Devices[:0]
		for _, device := range m.legacySharedControl.Devices {
			if device.Scope != scope || device.LastSeenAt != 0 {
				filtered = append(filtered, device)
			}
		}
		m.legacySharedControl.Devices = filtered
	} else {
		for _, device := range m.legacySharedControl.Devices {
			if device.Scope == scope && device.LastSeenAt == 0 {
				return LegacySharedControlPairingMaterial{
					DeviceID: device.DeviceID, DeviceToken: device.Token,
					PublicKeyB64: keypair.PublicKeyB64, Scope: scope,
				}, nil
			}
		}
	}
	device := LegacySharedControlDevice{
		DeviceID: newID("device"), Name: name, Token: randomLegacySharedControlHex(24),
		Scope: scope, PairedAt: time.Now().UnixMilli(),
	}
	m.legacySharedControl.Devices = append(m.legacySharedControl.Devices, device)
	if err := m.saveLocked(); err != nil {
		return LegacySharedControlPairingMaterial{}, err
	}
	return LegacySharedControlPairingMaterial{
		DeviceID: device.DeviceID, DeviceToken: device.Token,
		PublicKeyB64: keypair.PublicKeyB64, Scope: scope,
	}, nil
}

func (m *Manager) ValidateLegacySharedControlToken(token string) (LegacySharedControlDevice, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, device := range m.legacySharedControl.Devices {
		if device.Token == token {
			return device, true
		}
	}
	return LegacySharedControlDevice{}, false
}

func (m *Manager) ListLegacySharedControlDevices() []LegacySharedControlDevice {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]LegacySharedControlDevice(nil), m.legacySharedControl.Devices...)
}

func (m *Manager) RevokeLegacySharedControlDevice(deviceID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for index, device := range m.legacySharedControl.Devices {
		if device.DeviceID != deviceID {
			continue
		}
		m.legacySharedControl.Devices = append(m.legacySharedControl.Devices[:index], m.legacySharedControl.Devices[index+1:]...)
		_ = m.saveLocked()
		return true
	}
	return false
}

func (m *Manager) LegacySharedControlRuntimeID() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.relayID
}

func (m *Manager) TouchLegacySharedControlDevice(deviceID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for index := range m.legacySharedControl.Devices {
		if m.legacySharedControl.Devices[index].DeviceID == deviceID {
			m.legacySharedControl.Devices[index].LastSeenAt = time.Now().UnixMilli()
			_ = m.saveLocked()
			return
		}
	}
}

func DecodeLegacySharedControlSecret(keypair LegacySharedControlKeypair) (*[32]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(keypair.SecretKeyB64)
	if err != nil || len(raw) != 32 {
		return nil, errors.New("invalid legacy shared-control secret key")
	}
	var secret [32]byte
	copy(secret[:], raw)
	return &secret, nil
}

func validLegacySharedControlKeypair(keypair LegacySharedControlKeypair) bool {
	publicKey, publicErr := base64.StdEncoding.DecodeString(keypair.PublicKeyB64)
	secretKey, secretErr := base64.StdEncoding.DecodeString(keypair.SecretKeyB64)
	return publicErr == nil && secretErr == nil && len(publicKey) == 32 && len(secretKey) == 32
}

func randomLegacySharedControlHex(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buffer)
}
