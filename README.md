# LMI Paper Agent

LMI 연구 주제와 관련된 논문을 지정 저널에서 수집하고, 공동 검토용 GitHub Pages에 게시하는 운영 저장소입니다.

## Production flow

1. 매주 일요일 09:00 KST에 GitHub Actions가 최근 14일을 겹쳐 조회합니다.
2. Crossref 메타데이터를 LMI rubric으로 평가하고 DOI 기준으로 중복을 제거합니다.
3. 누적 카탈로그와 최근 1년 웹 데이터가 갱신됩니다.
4. 같은 workflow가 사이트를 빌드하고 GitHub Pages에 배포합니다.

감시 저널과 연구 키워드는 각각 `config/journals.yml`, `config/lab_profile.yml`에서 수정합니다. 교수·박사 추천은 `config/expert_recommendations.csv`에 DOI, 이름, 역할, 메모를 추가하면 사이트에 표시됩니다.

## Local development

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
corepack enable
pnpm install
pnpm dev
```

## Verification

```powershell
python -m unittest discover -s tests -v
python -m paper_agent.export_site_json --as-of 2026-08-13
pnpm build
```

## Manual production update

GitHub의 `Actions > Weekly Production Update > Run workflow`에서 즉시 실행할 수 있습니다. Crossref polite pool 사용을 위해 저장소 Secret `LMI_CROSSREF_MAILTO`에 연락용 이메일을 등록하는 것을 권장합니다.

## Data files

- `data/catalog/papers_table.csv`: DOI 중복 제거된 운영 카탈로그
- `data/weekly_updates/`: 실행일별 신규 논문
- `data/weekly_collection_state.json`: 마지막 실행 상태와 수집 건수
- `public/data/papers.json`: 웹사이트가 읽는 최근 1년 데이터

현재 리뷰 점수와 노트는 브라우저별 `localStorage`에 저장됩니다. 여러 연구원이 같은 리뷰를 공유하는 운영 단계는 Supabase Auth와 PostgreSQL을 연결해 완성합니다.
