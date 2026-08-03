# LMI Paper Agent

LMI 연구실의 논문 수집, 선별, 공동 검토를 위한 GitHub Pages 웹앱입니다.

## Local development

```bash
pnpm install
pnpm dev
```

## Data update

사이트는 `public/data/papers.json`을 읽습니다. 수집기는 이 파일의 `generatedAt`과 `papers`를 갱신하면 됩니다. 빌드 결과는 GitHub Actions를 통해 GitHub Pages에 자동 배포됩니다.

## Review data

현재 1차 버전의 점수와 리뷰 노트는 브라우저 `localStorage`에 저장됩니다. 공동 계정별 동기화는 다음 단계에서 Supabase 또는 별도 API로 연결합니다.
