package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// SSH holds one persistent connection to the worker. Sessions are cheap to
// open per poll on top of the pooled *ssh.Client (no TCP re-handshake).
type SSH struct {
	addr   string
	client *ssh.Client
	mu     sync.Mutex
}

func sshAuthMethods() []ssh.AuthMethod {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var methods []ssh.AuthMethod
	for _, kf := range []string{"id_ed25519", "id_ecdsa", "id_rsa"} {
		p := filepath.Join(home, ".ssh", kf)
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		signer, err := ssh.ParsePrivateKey(b)
		if err == nil {
			methods = append(methods, ssh.PublicKeys(signer))
			break
		}
	}
	if sock := os.Getenv("SSH_AUTH_SOCK"); sock != "" {
		if conn, err := net.Dial("unix", sock); err == nil {
			ag := agent.NewClient(conn)
			methods = append(methods, ssh.PublicKeysCallback(ag.Signers))
		}
	}
	return methods
}

func hostKeyCallback(insecure bool) ssh.HostKeyCallback {
	if insecure {
		return ssh.InsecureIgnoreHostKey()
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ssh.InsecureIgnoreHostKey()
	}
	cb, err := knownhosts.New(filepath.Join(home, ".ssh", "known_hosts"))
	if err != nil {
		return ssh.InsecureIgnoreHostKey()
	}
	return cb
}

// Dial connects (once) to the worker; reused for the life of the process.
func DialSSH(host, port, user string, insecure bool) (*SSH, error) {
	cfg := &ssh.ClientConfig{
		User:            user,
		Auth:            sshAuthMethods(),
		HostKeyCallback: hostKeyCallback(insecure),
		Timeout:         6 * time.Second,
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(host, port), cfg)
	if err != nil {
		return nil, err
	}
	return &SSH{addr: net.JoinHostPort(host, port), client: client}, nil
}

// Run executes the embedded collect script on the remote node and parses the
// tagged output. The SSH client is protected by a mutex so concurrent polls
// don't step on the session.
func (s *SSH) Run(ctx context.Context) (rawMetrics, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client == nil {
		return rawMetrics{}, fmt.Errorf("worker ssh not connected")
	}
	sess, err := s.client.NewSession()
	if err != nil {
		return rawMetrics{}, err
	}
	defer sess.Close()
	sess.Stdin = strings.NewReader(collectScript)
	out, err := sess.Output("bash")
	if err != nil {
		return rawMetrics{}, err
	}
	return parseCollectOutput(string(out)), nil
}

func (s *SSH) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client != nil {
		s.client.Close()
	}
}
