# Git upload checklist

1. Confirm the project root is the folder containing `backend`, `frontend`, and `.gitignore`.
2. Check Git's changes before staging: `git status --short`.
3. Ensure `.env`, `.venv`, `node_modules`, `dist`, cache folders, and real API keys are not listed as files to upload.
4. Add and commit project source, lockfiles, README, and `.env.example` only after reviewing the list.
5. Set a GitHub remote before pushing. Never paste an API key into GitHub or a chat.
