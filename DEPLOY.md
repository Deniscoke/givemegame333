# Deploy — GitHub + Vercel

## 1. Push na GitHub

V termináli v priečinku projektu:

```powershell
# Ak ešte nemáš git init
git init

# Pridaj všetko ( .env sa necommitne — je v .gitignore )
git add .
git status

# Commit
git commit -m "Deploy: gIVEMEGAME.IO ready for Vercel"

# Vytvor repozitár na github.com (New repository) a potom:
git remote add origin https://github.com/TVOJ_USERNAME/gIVEMEGAME.IO.git
git branch -M main
git push -u origin main
```

**Dôležité:** Nahraď `TVOJ_USERNAME` svojím GitHub menom. Repozitár vytvor na [github.com/new](https://github.com/new).

---

## 2. Deploy na Vercel

### A) Cez Vercel Dashboard (najjednoduchšie)

1. Choď na [vercel.com](https://vercel.com) a prihlás sa (cez GitHub).
2. **Add New** → **Project**.
3. Importuj svoj repozitár `gIVEMEGAME.IO`.
4. **Environment Variables** — pridaj:
   - `OPENAI_API_KEY` = tvoj OpenAI kľúč (sk-...)
5. Klikni **Deploy**.

### B) Cez Vercel CLI

```powershell
# Inštalácia (ak nemáš)
npm i -g vercel

# Prihlásenie (ak potrebuješ)
vercel login

# Deploy
vercel

# Pri prvom deployi odpovedz na otázky:
# - Set up and deploy? Y
# - Which scope? (tvoj účet)
# - Link to existing project? N
# - Project name? givemegame-io
# - Directory? ./
```

Potom pridaj env premenné v [vercel.com/dashboard](https://vercel.com) → tvoj projekt → Settings → Environment Variables.

---

## 3. Výsledok

Po deployi dostaneš URL, napr.:
```
https://givemegame-io.vercel.app
```

Túto URL môžeš poslať kamarátovi — funguje bez tunelov.

---

## Alternatíva: Render

Ak preferuješ Render namiesto Vercel, pozri `render.yaml` a [render.com](https://render.com). Postup je podobný — pripoj GitHub a deploy.
