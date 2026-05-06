# avformat/rtspdec: 1-byte heap-buffer-underflow in `rtsp_read_announce`

> Disclosed via [FFmpeg PR #22902](https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/22902). Fix merged.

## TL;DR

In RTSP **listen mode**, `rtsp_read_announce()` parsed the client-supplied `Content-Length` into a signed `int`. Sending `Content-Length: 4294967295` wrapped the value to `-1`, after which `av_malloc(content_length + 1)` evaluated to `av_malloc(0)`. FFmpeg's zero-size allocation fallback returns a 1-byte allocation, and the trailing `sdp[content_length] = '\0'` then writes a NUL byte at `sdp[-1]` — one byte before the start of that 1-byte region. A 1-byte heap-buffer-underflow.

## Component

- File: `libavformat/rtspdec.c`
- Function: `rtsp_read_announce`
- Reachable from any FFmpeg invocation running as an RTSP server:

```bash
ffmpeg -rtsp_flags listen -listen_timeout 10 \
       -i rtsp://127.0.0.1:8579/poc -f null -
```

The bug fires while parsing a client `ANNOUNCE` request and requires no media file.

## Root Cause

`ff_rtsp_parse_line()` reads `Content-Length:` with `strtol()` and stores the result into the signed-`int` field `request.content_length`. On builds where `int` is 32-bit, `Content-Length: 4294967295` parses as `2^32 − 1` and the implicit cast yields `-1`.

The handler in `rtspdec.c` only guards against the zero case, not the negative case:

```c
// libavformat/rtspdec.c (excerpt)
if (request.content_length) {
    sdp = av_malloc(request.content_length + 1);   // line 195
    // ... read body into sdp ...
    sdp[request.content_length] = '\0';            // line 208
}
```

Two FFmpeg-allocator behaviors then conspire:

1. `av_malloc(content_length + 1)` → `av_malloc(0)` → returns a **1-byte fallback** rather than `NULL`.
2. `sdp[request.content_length] = '\0'` → `sdp[-1] = '\0'` — one byte before the start of the allocation.

## Reproduction

```bash
python3 poc_rtsp_listen_heap_underflow.py 127.0.0.1 8579
```

The PoC sends one `ANNOUNCE` whose only meaningful header is `Content-Length: 4294967295`. No external media file required.

## ASan / Valgrind

AddressSanitizer points at the write 1 byte to the **left** of a 1-byte region, with both the malloc and the bad write originating in `rtsp_read_announce`:

```text
==ERROR: AddressSanitizer: heap-buffer-overflow on address 0xffffa8e006cf
WRITE of size 1 at 0xffffa8e006cf thread T0
    #0 rtsp_read_announce  libavformat/rtspdec.c:208

0xffffa8e006cf is located 1 bytes to the left of 1-byte region
[0xffffa8e006d0,0xffffa8e006d1)
allocated by thread T0 here:
    #1 av_malloc           libavutil/mem.c:107
    #2 av_malloc           libavutil/mem.c:146
    #3 rtsp_read_announce  libavformat/rtspdec.c:195
```

Valgrind on a separate non-ASan debug build of the same revision agrees:

```text
Invalid write of size 1
   at rtsp_read_announce (rtspdec.c:208)
 Address 0x52b4eef is 1 bytes before a block of size 1 alloc'd
   by av_malloc (mem.c:107)
   by av_malloc (mem.c:146)
   by rtsp_read_announce (rtspdec.c:195)
```

## Fix

Reject any non-positive `Content-Length` before allocation, closing both the wrap-to-negative path and the zero-size path at a single check site:

```c
if (request.content_length <= 0) {
    av_log(s, AV_LOG_ERROR, "Invalid Content-Length\n");
    return AVERROR_INVALIDDATA;
}
```

## Impact

The demonstrated primitive is a 1-byte NUL underflow. The byte lands inside allocator-adjacent metadata under glibc; the resulting effect on heap state depends on layout. Direct exploitation isn't claimed here, but allocator metadata corruption with potential follow-on impact under favorable layouts can't be ruled out without further analysis.

RTSP listen mode is the documented way to run FFmpeg as an RTSP server (media gateway / forwarder), so the surface is reachable from any client speaking the protocol.

## Links

- PR: <https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/22902>
- File: [`libavformat/rtspdec.c`](https://code.ffmpeg.org/FFmpeg/FFmpeg/src/branch/master/libavformat/rtspdec.c)
- Affected revision at report time: `N-123885-g283faf55f8`
