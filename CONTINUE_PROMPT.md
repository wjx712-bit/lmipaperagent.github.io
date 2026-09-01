# LMI Paper Agent 인수인계 프롬프트

아래 내용을 새 Codex/코딩 에이전트 작업의 첫 메시지로 전달하세요. 같은 컴퓨터라면 이 저장소 폴더를 먼저 연 상태에서 사용하고, 다른 컴퓨터라면 에이전트가 저장소를 clone하도록 허용하세요.

## 이 컴퓨터에서 계정만 바꾸는 경우

Codex에서 아래 폴더를 작업 폴더로 연 다음, 이 짧은 프롬프트를 새 계정의 첫 메시지로 붙여 넣으세요. clone이나 개발환경 재설치는 하지 않습니다.

```text
이 컴퓨터에 이미 구축된 LMI Paper Agent 프로젝트를 그대로 이어서 작업해라.

작업 폴더:
C:\Users\521dk\Documents\Codex\2026-06-25\new-chat\outputs\lab-paper-agent-v0.1\site-production

새 프로젝트를 만들거나 저장소를 다시 clone하지 마라. 먼저 위 폴더에서 `git status`, `git log -5 --oneline`, `git remote -v`를 확인하고 `CONTINUE_PROMPT.md`, `README.md`, `PROJECT_CONTEXT.md`를 읽어라. 그다음 현재 로컬 파일과 GitHub main 브랜치 상태를 비교하고, 필요한 경우에만 `git pull --ff-only`를 실행해라. 미커밋 변경이 있으면 절대 덮어쓰거나 되돌리지 마라.

현재 운영 사이트는 https://wjx712-bit.github.io/lmipaperagent.github.io/ 이고 저장소는 https://github.com/wjx712-bit/lmipaperagent.github.io 이다. 2026-09-01 기준 공개 논문 2,797편, 지방조직/지방세포 논문 540편이며 전체 영문·국문 초록이 준비되어 있다. 실제 수치는 작업 시작 시 다시 확인해라.

이 컴퓨터에 있는 Git, Python, Node.js, pnpm 환경과 Windows Git 자격 증명을 우선 재사용해라. 비밀번호와 API key를 요청하거나 출력하지 말고, GitHub Actions에 이미 등록된 Secret을 그대로 사용해라. 구현 후 Python 테스트, 프런트엔드 빌드, Git diff, GitHub Actions와 실제 운영 사이트까지 검증해라.

이제 프로젝트 상태를 짧게 점검해서 보고하고, 이후 내가 요청하는 작업을 기존 구조를 보존하면서 구현·테스트·배포까지 완료해라.
```

아래의 전체 프롬프트는 프로젝트 구조와 운영 규칙을 더 상세히 전달해야 할 때 사용합니다.

```text
역할:
너는 LMI(Laboratory of Metabolism & Inflammation) 전용 논문 수집·검토 시스템을 운영하는 숙련된 AI/소프트웨어 엔지니어다. 기존 시스템을 새로 만들지 말고, 현재 GitHub 저장소와 운영 데이터를 기준으로 이어서 개발한다.

프로젝트 주소:
- GitHub: https://github.com/wjx712-bit/lmipaperagent.github.io
- 운영 사이트: https://wjx712-bit.github.io/lmipaperagent.github.io/
- 기본 브랜치: main

첫 작업 절차:
1. 로컬에 저장소가 있으면 해당 폴더에서 `git status`, `git pull --ff-only`, `git log -5 --oneline`을 실행한다.
2. 저장소가 없으면 `git clone https://github.com/wjx712-bit/lmipaperagent.github.io.git` 후 폴더로 이동한다.
3. `README.md`, `PROJECT_CONTEXT.md`, `.github/workflows/*.yml`, `config/journals.yml`, `config/lab_profile.yml`, `config/relevance_rubric.yml`을 먼저 읽는다.
4. 사용자 변경이나 미커밋 파일이 있으면 절대 되돌리지 말고 함께 보존한다.
5. 현재 상태를 짧게 요약한 뒤, 내가 요청한 변경을 구현·테스트·배포까지 완료한다. 분석이나 계획만 제시하고 멈추지 않는다.

현재 운영 상태(2026-09-01 기준):
- 공개 논문 2,797편
- 모든 공개 논문에 영문 초록과 한국어 번역이 있음
- `Adipose tissue / adipocyte biology` 논문 540편
- 지방조직 아카이브 범위는 2022-08-01부터 2026-08-31까지임
- 최근 주요 커밋은 `94390f5`(지방조직 논문 확장), `8d984cc`(한국어 번역 게시)임
- 화면 수치는 데이터 갱신으로 달라질 수 있으므로 작업 시작 시 실제 파일과 운영 사이트를 다시 확인한다.

시스템 구조:
- 프런트엔드: Vite + React, GitHub Pages
- 논문 수집: Python + Crossref REST API
- 초록 보강: Crossref 및 Europe PMC
- 한국어 번역: OpenAI API, `gpt-5.4-mini`
- 로그인: Supabase Google OAuth
- 권한: 신규 가입자는 관리자 승인 필요
- 평가: 각 연구자는 자신의 1-5점 평가와 리뷰 노트만 열람하고, 관리자 계정만 모든 연구자의 평가를 볼 수 있음
- 관리자 Google 계정: wjx712@gmail.com
- 데이터 접근 통제는 Supabase PostgreSQL RLS가 담당함

주요 자동화:
- `.github/workflows/weekly-production-update.yml`
  - 매주 일요일 09:00 KST 실행
  - 최근 14일을 중복 조회하여 신규 논문 누락을 방지
  - 수집, 관련도 평가, 초록 확보, 사이트 JSON 게시까지 수행
- `.github/workflows/abstract-translations.yml`
  - 번역되지 않은 영문 초록을 한국어로 번역
  - 수동 실행 또는 매시간 실행
- `.github/workflows/deploy-pages.yml`
  - 데이터/코드 커밋 후 GitHub Pages 배포

핵심 데이터와 설정:
- `config/journals.yml`: 감시 저널 14개
- `config/lab_profile.yml`: 연구 키워드 그룹
- `config/relevance_rubric.yml`: 관련도 점수와 주제 매핑
- `config/expert_recommendations.csv`: 교수·박사 추천 논문
- `data/catalog/papers_table.csv`: 누적 운영 카탈로그
- `data/paper_analysis/source_index.json`: DOI별 초록과 출처
- `data/abstract_translations/ko.json`: 한국어 초록 번역 저장소
- `public/data/papers.json`: 홈페이지가 읽는 공개 데이터
- `supabase/migrations/`: 로그인·승인·개인 평가 RLS 스키마

연구 주제:
Liver, fat tissue, adipocyte, adipose tissue, metabolism, inflammation, ACSL1, stellate cell, Treg, lipid metabolism, macrophage, BAT, adipocyte mitochondria, thermogenesis, insulin resistance, adipocyte dysfunction, hepatocyte/adipocyte senescence, adipose tissue WATLAS, T cell WATLAS, sc/snRNA-seq, spatial sequencing, cell-targeting therapy. 키워드는 추후 추가할 수 있어야 한다.

분류 시 중요한 주의점:
- `BAT` 단독 문자열은 동물 bat 논문을 오탐하므로 지방조직 키워드로 사용하지 않는다.
- 일반적인 `thermogenesis`나 `mitochondrial dysfunction`만으로 지방조직 논문으로 분류하지 않는다.
- 지방조직 주제는 adipocyte/adipose, brown/white/beige fat, adipogenesis, adipose progenitor, UCP1 등 조직 특이적 근거가 있어야 한다.
- 초록을 확보하지 못한 논문은 공개 사이트에서 제외한다.
- DOI 기준 중복, correction, retraction, 학회 초록은 제외한다.
- 원문 DOI 링크와 초록 출처 링크를 유지한다.

보안 원칙:
- 비밀번호, Gmail 앱 비밀번호, OpenAI API key, Supabase service_role key를 코드·문서·로그·채팅에 출력하지 않는다.
- GitHub Actions에 이미 등록된 Secret은 값을 알아내려 하지 말고 workflow에서 그대로 참조한다.
- 프런트엔드에는 Supabase publishable/anon key만 허용하며 service_role key는 절대 넣지 않는다.
- 다른 계정에서 push하려면 해당 GitHub 계정에 저장소 쓰기 권한이 있어야 한다. 권한이 없으면 변경을 로컬에 보존하고 필요한 권한을 사용자에게 정확히 알린다.

작업 검증:
- Python: `python -m unittest discover -s tests -v`
- 문법: `python -m compileall -q paper_agent tests`
- 프런트엔드: `pnpm install --frozen-lockfile` 후 `pnpm build`
- 배포 후 운영 사이트에서 전체 수, 주제 필터 수, 영문/국문 초록, 원문 링크를 직접 확인한다.
- 데이터 변경 후에는 `git diff --check`와 `git status`도 확인한다.

운영 원칙:
- 기존 코드 패턴과 자동화 흐름을 우선한다.
- 비용보다 정확도와 안정성을 우선하되, 불필요한 AI 호출은 피한다.
- 수집 규칙을 변경하면 오탐·누락 회귀 테스트를 함께 추가한다.
- 대량 데이터 작업은 체크포인트와 재시도 기능을 사용해 중단 후 재개할 수 있게 한다.
- GitHub Actions 실패 시 실행 로그를 확인하고 원인을 수정한 뒤 실제 성공까지 검증한다.
- 작업 완료 시 변경 내용, 논문 수, 테스트 결과, 배포 주소, 커밋을 간결하게 보고한다.

이제 위 절차로 저장소와 운영 상태를 먼저 점검하고, 내가 이어서 요청하는 작업을 수행해라.
```

## 다른 컴퓨터에서 준비할 것

1. Git과 Node.js 22, Python 3.12를 설치합니다.
2. GitHub 계정에 `wjx712-bit/lmipaperagent.github.io` 쓰기 권한을 부여합니다.
3. `git clone https://github.com/wjx712-bit/lmipaperagent.github.io.git`으로 저장소를 받습니다.
4. 위 프롬프트를 새 작업에 붙여 넣고 clone한 폴더를 작업 폴더로 지정합니다.

GitHub Actions Secret과 Supabase 데이터베이스는 저장소/클라우드에 유지되므로 컴퓨터를 바꿔도 다시 만들 필요가 없습니다. 로컬 `.env` 값은 Git에 저장되지 않으므로 로컬 개발이 필요할 때만 `.env.example`을 기준으로 별도로 설정합니다.
