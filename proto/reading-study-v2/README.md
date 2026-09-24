# 구절 연구 HTML 데모

`index.html` 단일 파일에 스타일과 동작이 모두 포함되어 있다. 파일을 브라우저에서 직접 열거나 아래 명령으로 제공한다.

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory proto/reading-study-v2
```

미리 준비한 어휘 6개 선택, 독음 채택, 뜻 저장, 용례 비교, 원문 앞뒤 문맥, 연결 번역 편집, 방향키와 Cmd/Ctrl+S를 체험할 수 있다. 실제 앱의 DB와 연결되지 않으며 시연 뜻/비교 예문이 포함된다. 저장은 브라우저의 전용 localStorage 키에만 반영된다.
