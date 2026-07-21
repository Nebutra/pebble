package runtimehttp

import (
	"crypto/rand"
	"encoding/base64"
	"errors"

	"golang.org/x/crypto/nacl/box"
)

const legacySharedControlNonceBytes = 24

func deriveLegacySharedControlKey(clientPublicKeyB64 string, serverSecretKey *[32]byte) (*[32]byte, error) {
	clientBytes, err := base64.StdEncoding.DecodeString(clientPublicKeyB64)
	if err != nil || len(clientBytes) != 32 {
		return nil, errors.New("invalid client public key")
	}
	var clientPublicKey [32]byte
	copy(clientPublicKey[:], clientBytes)
	var shared [32]byte
	box.Precompute(&shared, &clientPublicKey, serverSecretKey)
	return &shared, nil
}

func encryptLegacySharedControlText(plaintext []byte, sharedKey *[32]byte) (string, error) {
	var nonce [legacySharedControlNonceBytes]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	bundle := append(nonce[:], box.SealAfterPrecomputation(nil, plaintext, &nonce, sharedKey)...)
	return base64.StdEncoding.EncodeToString(bundle), nil
}

func decryptLegacySharedControlText(encoded string, sharedKey *[32]byte) ([]byte, error) {
	bundle, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(bundle) < legacySharedControlNonceBytes+box.Overhead {
		return nil, errors.New("invalid encrypted frame")
	}
	var nonce [legacySharedControlNonceBytes]byte
	copy(nonce[:], bundle[:legacySharedControlNonceBytes])
	plaintext, ok := box.OpenAfterPrecomputation(nil, bundle[legacySharedControlNonceBytes:], &nonce, sharedKey)
	if !ok {
		return nil, errors.New("could not decrypt frame")
	}
	return plaintext, nil
}

func encryptLegacySharedControlBytes(plaintext []byte, sharedKey *[32]byte) ([]byte, error) {
	var nonce [legacySharedControlNonceBytes]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	return append(nonce[:], box.SealAfterPrecomputation(nil, plaintext, &nonce, sharedKey)...), nil
}

func decryptLegacySharedControlBytes(bundle []byte, sharedKey *[32]byte) ([]byte, error) {
	if len(bundle) < legacySharedControlNonceBytes+box.Overhead {
		return nil, errors.New("invalid encrypted binary frame")
	}
	var nonce [legacySharedControlNonceBytes]byte
	copy(nonce[:], bundle[:legacySharedControlNonceBytes])
	plaintext, ok := box.OpenAfterPrecomputation(nil, bundle[legacySharedControlNonceBytes:], &nonce, sharedKey)
	if !ok {
		return nil, errors.New("could not decrypt binary frame")
	}
	return plaintext, nil
}
