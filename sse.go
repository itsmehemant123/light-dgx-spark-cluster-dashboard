package main

import (
	"fmt"
	"sync"
)

// Hub fans out pre-formatted SSE frames to all connected browser clients.
// Server is stateless pass-through: no history, no per-client buffering beyond
// the small outbound write channel.
type Hub struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
	seq  int64
}

func newHub() *Hub {
	return &Hub{subs: map[chan []byte]struct{}{}}
}

func (h *Hub) subscribe() (chan []byte, int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.seq++
	ch := make(chan []byte, 32)
	h.subs[ch] = struct{}{}
	return ch, h.seq
}

func (h *Hub) unsubscribe(ch chan []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, ch)
}

func (h *Hub) publish(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- msg:
		default: // slow consumer: drop this frame rather than grow memory
		}
	}
}

func sseFrame(event, data string) []byte {
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, data))
}
