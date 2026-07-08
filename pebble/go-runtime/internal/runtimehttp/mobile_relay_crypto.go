package runtimehttp

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"

	"github.com/tsekaluk/pebble/go-runtime/internal/runtimecore"
)

const mobileRelayCryptoAlgorithm = "X25519-HKDF-SHA256-AES-256-GCM"
const mobileRelayCryptoAssociatedData = "pebble.mobile-relay.v1"

type relayCryptoEnvelope struct {
	KeyID          string `json:"keyId"`
	Nonce          string `json:"nonce"`
	Ciphertext     string `json:"ciphertext"`
	AssociatedData string `json:"associatedData,omitempty"`
}

type cryptoHandshakePayload struct {
	Device           runtimecore.MobileRelayDeviceIdentity `json:"device"`
	ClientPublicKey  string                                `json:"clientPublicKey"`
	PairingSecretRef string                                `json:"pairingSecretRef,omitempty"`
	Subscriptions    []runtimecore.ProjectionKind          `json:"subscriptions,omitempty"`
}

type cryptoReadyPayload struct {
	Algorithm       string `json:"algorithm"`
	KeyID           string `json:"keyId"`
	ServerPublicKey string `json:"serverPublicKey"`
	AssociatedData  string `json:"associatedData"`
}

type mobileRelayCryptoSession struct {
	keyID string
	aead  cipher.AEAD
}

func newMobileRelayServerCryptoSession(
	clientPublicKey string,
	pairingSecretRef string,
	relayID string,
) (*mobileRelayCryptoSession, cryptoReadyPayload, error) {
	clientPublicKeyBytes, err := decodeRelayBase64(clientPublicKey)
	if err != nil {
		return nil, cryptoReadyPayload{}, err
	}
	curve := ecdh.X25519()
	clientKey, err := curve.NewPublicKey(clientPublicKeyBytes)
	if err != nil {
		return nil, cryptoReadyPayload{}, fmt.Errorf("invalid client public key: %w", err)
	}
	serverPrivateKey, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, cryptoReadyPayload{}, err
	}
	sharedSecret, err := serverPrivateKey.ECDH(clientKey)
	if err != nil {
		return nil, cryptoReadyPayload{}, err
	}
	session, err := newMobileRelayCryptoSessionFromSecret(sharedSecret, pairingSecretRef, relayID)
	if err != nil {
		return nil, cryptoReadyPayload{}, err
	}
	return session, cryptoReadyPayload{
		Algorithm:       mobileRelayCryptoAlgorithm,
		KeyID:           session.keyID,
		ServerPublicKey: encodeRelayBase64(serverPrivateKey.PublicKey().Bytes()),
		AssociatedData:  mobileRelayCryptoAssociatedData,
	}, nil
}

func newMobileRelayClientCryptoSession(
	clientPrivateKey *ecdh.PrivateKey,
	ready cryptoReadyPayload,
	pairingSecretRef string,
	relayID string,
) (*mobileRelayCryptoSession, error) {
	if ready.Algorithm != mobileRelayCryptoAlgorithm {
		return nil, errors.New("unsupported relay crypto algorithm")
	}
	serverPublicKeyBytes, err := decodeRelayBase64(ready.ServerPublicKey)
	if err != nil {
		return nil, err
	}
	serverPublicKey, err := ecdh.X25519().NewPublicKey(serverPublicKeyBytes)
	if err != nil {
		return nil, err
	}
	sharedSecret, err := clientPrivateKey.ECDH(serverPublicKey)
	if err != nil {
		return nil, err
	}
	session, err := newMobileRelayCryptoSessionFromSecret(sharedSecret, pairingSecretRef, relayID)
	if err != nil {
		return nil, err
	}
	if session.keyID != ready.KeyID {
		return nil, errors.New("relay crypto key id mismatch")
	}
	return session, nil
}

func newMobileRelayCryptoSessionFromSecret(
	sharedSecret []byte,
	pairingSecretRef string,
	relayID string,
) (*mobileRelayCryptoSession, error) {
	saltHash := sha256.Sum256([]byte("pebble-mobile-relay:" + relayID + ":" + pairingSecretRef))
	key, err := hkdf.Key(sha256.New, sharedSecret, saltHash[:], mobileRelayCryptoAlgorithm, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	keyHash := sha256.Sum256(key)
	return &mobileRelayCryptoSession{
		keyID: encodeRelayBase64(keyHash[:16]),
		aead:  aead,
	}, nil
}

func (s *mobileRelayCryptoSession) encrypt(plaintext []byte) (relayCryptoEnvelope, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return relayCryptoEnvelope{}, err
	}
	ciphertext := s.aead.Seal(nil, nonce, plaintext, []byte(mobileRelayCryptoAssociatedData))
	return relayCryptoEnvelope{
		KeyID:          s.keyID,
		Nonce:          encodeRelayBase64(nonce),
		Ciphertext:     encodeRelayBase64(ciphertext),
		AssociatedData: mobileRelayCryptoAssociatedData,
	}, nil
}

func (s *mobileRelayCryptoSession) decrypt(envelope relayCryptoEnvelope) ([]byte, error) {
	if envelope.KeyID != s.keyID {
		return nil, errors.New("relay crypto key id mismatch")
	}
	if envelope.AssociatedData != "" && envelope.AssociatedData != mobileRelayCryptoAssociatedData {
		return nil, errors.New("relay crypto associated data mismatch")
	}
	nonce, err := decodeRelayBase64(envelope.Nonce)
	if err != nil {
		return nil, err
	}
	if len(nonce) != s.aead.NonceSize() {
		return nil, errors.New("relay crypto nonce has invalid length")
	}
	ciphertext, err := decodeRelayBase64(envelope.Ciphertext)
	if err != nil {
		return nil, err
	}
	return s.aead.Open(nil, nonce, ciphertext, []byte(mobileRelayCryptoAssociatedData))
}

func encodeRelayBase64(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func decodeRelayBase64(value string) ([]byte, error) {
	if decoded, err := base64.RawURLEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	if decoded, err := base64.StdEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	if decoded, err := base64.RawStdEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	if decoded, err := base64.URLEncoding.DecodeString(value); err == nil {
		return decoded, nil
	}
	return nil, errors.New("value is not valid base64")
}
