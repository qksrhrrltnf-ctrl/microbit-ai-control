# micro:bit AI 제어

**AI 인식으로 micro:bit를 움직이는 웹앱 모음.**
이미지·포즈·손모양·사물·얼굴·음성 6가지 인식과 센서 데이터 그래프까지, 모두 브라우저에서 동작합니다.

설치도, 회원가입도, 서버도 없습니다. `git push` 하면 GitHub Pages가 그대로 서빙합니다.

```
카메라 / 마이크 ──▶ AI 인식 ──▶ 결과 + 확률
                                   │
               신뢰도 기준 · 연속 확인으로 걸러냄
                                   │
                     결과 → 명령어 매핑
                                   │
         Web Bluetooth (UART) ──▶ micro:bit
```

## 기능

| 페이지 | 기능 | 학습 | 보내는 것 |
|---|---|---|---|
| [`index.html`](index.html) | 허브 — 시작 안내, 브라우저 지원 확인 | — | — |
| [`image.html`](image.html) | **이미지 분류** | Teachable Machine | 매핑한 명령어 |
| [`pose.html`](pose.html) | **포즈 분류** (골격 표시) | Teachable Machine | 매핑한 명령어 |
| [`handpose.html`](handpose.html) | **손모양 학습** (KNN) | **브라우저에서 바로** | 매핑한 명령어 |
| [`object.html`](object.html) | **사물인식** (80종) | 불필요 | 좌표 패킷 또는 이름 |
| [`face.html`](face.html) | **얼굴인식** (눈·입·기울기·미소) | 불필요 | 얼굴 패킷 |
| [`voice.html`](voice.html) | **음성인식** (CSV 명령 목록) | 불필요 | 매핑한 명령어 |
| [`streamer.html`](streamer.html) | **데이터 스트리머** (실시간 그래프 + CSV) | — | ← micro:bit가 보냄 |
| [`microbit/`](microbit/) | MakeCode 예제 6종 + 통신 규약 + 문제 해결 | — | — |

## 빠른 시작

1. **micro:bit 준비** — [`microbit/`](microbit/)의 예제를 MakeCode에 붙여넣고 다운로드합니다.
   프로젝트 설정에서 **No Pairing Required**를 꼭 켜세요.
2. **기능 고르기** — 학습이 필요 없는 **사물·얼굴·음성**부터가 가장 빠릅니다.
3. **직접 학습** — **손모양**은 브라우저에서 바로, **이미지·포즈**는
   [Teachable Machine](https://teachablemachine.withgoogle.com/)에서 학습한 모델을 불러옵니다.
4. **연결하고 실행** — 카메라 → 블루투스 → 모델 순으로 진행 후 **시작**.
   micro:bit가 없으면 **연습 모드**로 먼저 확인하세요.

## 특징

- **매핑 표** — 클래스명과 전송 명령을 분리했습니다. 클래스를 한글로 지어도 되고, 명령은 `go`처럼 짧게 보냅니다. 행마다 **테스트 버튼**이 있어 포즈를 잡지 않고도 배선을 확인할 수 있습니다.
- **오작동 억제** — 신뢰도 기준 + 연속 확인 횟수로 깜빡임을 걸러냅니다. 기본은 *결과가 바뀔 때만* 전송이라 통신이 명령으로 넘치지 않습니다.
- **연습 모드** — micro:bit 없이도 인식 결과와 전송될 명령을 확인할 수 있습니다. 기기가 모자란 교실에서 유용합니다.
- **전송 기록** — 무엇이 언제 나갔는지 전부 남습니다. 수업 중 문제 원인을 바로 찾을 수 있습니다.
- **브라우저에서 학습** — 손모양은 Teachable Machine 없이 이 페이지 안에서 학습이 끝납니다.
- **오프라인 모델 로드** — TM에서 내려받은 `model.json` / `weights.bin` / `metadata.json` 파일로도 불러올 수 있습니다.
- **자동 저장** — 학습 결과와 설정이 브라우저에 남아 새로고침·다음 수업에도 유지됩니다. 서버 없이 동작합니다.
- **한 번 학습해서 배포** — 손모양 학습을 파일로 내보내 학생 전체에게 나눠줄 수 있습니다.
- **모두 로컬 처리** — 영상·음성은 어디에도 전송되지 않습니다. 나가는 것은 짧은 문자열뿐입니다.
  (음성인식만 브라우저 제공 서비스를 이용해 인터넷이 필요합니다)

## 설정과 학습 내용 저장

서버도 데이터베이스도 쓰지 않습니다. **브라우저 안에(localStorage)** 저장되며 기기 밖으로 나가지 않습니다.

| 페이지 | 저장되는 것 |
|---|---|
| 손모양 | 손모양 목록 · KNN 학습 샘플 · 명령 연결 · 인식 설정 |
| 음성 | 명령어 목록 · 언어 · 맞추는 방법 · 재전송 간격 |
| 이미지 · 포즈 | 모델 주소 · 명령 연결 · 인식 설정 |
| 사물 · 얼굴 | 전송 방식 · 추적 대상 · 신뢰도 · 전송 간격 |
| 데이터 | 화면에 보일 표본 수 |

새로고침하거나 브라우저를 껐다 켜도 그대로 남습니다. 각 페이지의 **저장 내용 지우기** 버튼으로 초기화합니다.

### 한 번 학습해서 전체에게 나눠주기

손모양 학습은 **파일로 내보내기 / 불러오기**를 지원합니다.

1. 교사가 손모양을 한 번 학습시킨 뒤 **파일로 내보내기** → `handpose-training.json`
2. 그 파일을 학생들에게 배포 (수업 자료실, 메신저 등)
3. 학생은 **파일 불러오기** 한 번이면 학습 없이 동일하게 사용

30명이 각자 3분씩 학습할 필요가 없어집니다. 불러온 내용도 자동 저장되어 다음 시간까지 남습니다.

> 저장 공간은 약 5MB이며, 손모양 샘플 50개가 약 40KB입니다.
> 시크릿 모드나 저장이 차단된 환경에서는 저장되지 않는다고 화면에 표시됩니다.
> 여러 학생이 한 컴퓨터를 함께 쓰면 저장 내용이 공유되므로, 필요하면 **저장 내용 지우기**를 눌러주세요.

## 통신 규약

micro:bit 표준 UART 서비스를 사용합니다. 한 번에 보낼 수 있는 크기는 **20바이트**입니다.

| 항목 | UUID |
|---|---|
| Service | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| TX (micro:bit → 웹, notify) | `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |
| RX (웹 → micro:bit, write) | `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |

### 웹 → micro:bit

```
rock\n                  분류 결과 (이미지·포즈·손모양·음성) — 매핑 표에서 정한 명령어
person\n                사물 이름 (사물인식 · 이름 모드)
x200y150w080h060n02\n   사물 좌표 (사물인식 · 좌표 모드) — 중심 x,y / 크기 w,h / 개수 n
x50y42m30a90b88r5s2\n   얼굴 값 — 위치 x,y / 입 m / 왼눈 a / 오른눈 b / 기울기 r / 미소 s
stop\n                  인식을 멈췄거나 대상이 사라졌을 때 (항상 전송)
```

좌표·얼굴 패킷은 글자 하나 뒤에 정해진 자릿수의 숫자가 붙습니다.
micro:bit에서는 `substr`로 잘라 쓰면 됩니다 — [예제](microbit/#object) 참고.

### micro:bit → 웹 (데이터 스트리머)

```
light=123\n             이름과 값
light=123,temp=25\n     한 줄에 여러 개
123\n                   이름 없으면 value로 저장
```

## 사용 환경

| 환경 | 지원 |
|---|---|
| Chrome / Edge (Windows, macOS, Android, ChromeOS) | ✅ |
| iPhone / iPad Safari | ❌ → [Bluefy](https://apps.apple.com/app/id1492822055) 브라우저 사용 |
| Firefox | ❌ |

- **HTTPS 또는 localhost에서만** Web Bluetooth가 동작합니다. GitHub Pages는 기본 HTTPS입니다.
- micro:bit v1 / v2 모두 동작하지만, 메모리 여유가 있는 **v2를 권장**합니다.
- 블루투스와 **무선(Radio) 블록은 함께 쓸 수 없습니다.**

## GitHub Pages로 배포하기

빌드 과정이 없습니다. 그대로 올리면 끝입니다.

```bash
git remote add origin https://github.com/<사용자명>/<저장소명>.git
git push -u origin main
```

저장소 **Settings → Pages → Source: `main` / `(root)`** 로 설정하면
`https://<사용자명>.github.io/<저장소명>/` 에서 열립니다.

## 로컬에서 실행

`file://`로 열면 카메라·마이크·블루투스가 막히므로 간단한 서버를 띄웁니다.

```bash
python -m http.server 8000
```

그다음 `http://localhost:8000` 으로 접속하세요.

## 파일 구조

```
.
├── index.html          허브
├── image.html          이미지 분류 (TM)
├── pose.html           포즈 분류 (TM)
├── handpose.html       손모양 학습 (KNN)
├── object.html         사물인식
├── face.html           얼굴인식
├── voice.html          음성인식
├── streamer.html       데이터 스트리머
├── css/style.css       디자인 시스템 (레트로 · 크림 배경 · 하드 그림자)
├── js/
│   ├── microbit-ble.js  Web Bluetooth (UART) 코어 — 재사용 가능
│   ├── core.js          공용 부품: 로그 · 상태 · 카메라 · 매핑 · 전송정책 · 푸터
│   ├── model-runner.js  TM 이미지/포즈 모델 로더
│   ├── knn.js           손 특징 추출 + KNN 분류 (순수 계산, 단위 테스트 가능)
│   ├── store.js         브라우저 저장 + 파일 내보내기/불러오기
│   ├── app.js           이미지 · 포즈 페이지
│   ├── handpose.js      손모양 학습 페이지
│   ├── object.js        사물인식 페이지
│   ├── face.js          얼굴인식 페이지
│   ├── voice.js         음성인식 페이지
│   ├── streamer.js      데이터 스트리머 페이지
│   └── ui.js            스크롤 페이드인
└── microbit/index.html MakeCode 예제 + 통신 규약
```

기능 페이지는 모두 [`js/core.js`](js/core.js)의 공용 부품을 씁니다 —
BLE 연결·카메라·매핑 표·전송 정책·기록창이 한곳에 있어 한 번 고치면 전체에 반영됩니다.

`image.html`과 `pose.html`은 같은 [`js/app.js`](js/app.js)를 공유하며
`<body data-mode="image|pose">`로 동작 모드만 달라집니다.

## 제작자 표기 바꾸기

[`js/core.js`](js/core.js) 맨 위 두 줄만 채우면 모든 페이지 푸터에 반영됩니다.

```javascript
var CREDIT = {
  author: '홍길동',
  githubUrl: 'https://github.com/아이디/저장소'
};
```

## 사용 기술

- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe) — 손·사물·얼굴 인식 (Apache-2.0)
- [Teachable Machine](https://teachablemachine.withgoogle.com/) `@teachablemachine/image`, `@teachablemachine/pose` (Apache-2.0)
- [TensorFlow.js](https://www.tensorflow.org/js) (Apache-2.0)
- [Web Bluetooth API](https://webbluetoothcg.github.io/web-bluetooth/) · [Web Speech API](https://wicg.github.io/speech-api/)
- 폰트: [페이퍼로지](https://noonnu.cc/font_page/1099), [프리젠테이션](https://noonnu.cc/font_page/1010) (OFL)
- 프레임워크·빌드 도구 없음. 순수 HTML / CSS / JavaScript

## 라이선스

MIT — 수업, 연구, 리믹스 자유롭게 하세요.
