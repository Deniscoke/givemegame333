# Supabase backend pre gIVEMEGAME.IO

## Nastavenie

### 1. Spustite migrácie

1. Otvorte [Supabase Dashboard](https://supabase.com/dashboard) → váš projekt
2. **SQL Editor** → **New query**
3. Skopírujte a spustite v poradí:
   - `migrations/001_profiles_and_follows.sql`
   - `migrations/002_add_coins_to_profiles.sql`
   - `migrations/003_giveme_social.sql`
   - `migrations/004_add_prompt_to_posts.sql`
   - `migrations/005_quest_log.sql`
   - `migrations/007_add_scoreboard_to_profiles.sql`

### 2. Štruktúra

| Tabuľka   | Popis                                                                 |
|-----------|-----------------------------------------------------------------------|
| `profiles`| Profily (display_name, avatar, bio, **coins**, **games_generated**, **games_exported**) — auto-vytvorené pri Google login |
| `follows` | Kto koho sleduje (follower_id → following_id)                          |
| `giveme_posts` | Pixel art posty (image_data, caption, **prompt**)                    |
| `giveme_likes` | Lajky na posty                                                       |
| `giveme_comments` | Komentáre                                                            |
| `giveme_coin_donations` | Darovanie coinov autorom                                             |
| `quest_log` | Quest log — vygenerované hry per používateľ (nikdy sa nemazá)        |

### 3. Použitie v kóde

```javascript
// Načítať profil
const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();

// Aktualizovať profil
await supabase.from('profiles').update({ display_name, bio }).eq('id', userId);

// Sledovať používateľa
await supabase.from('follows').insert({ follower_id: myId, following_id: targetId });

// Zoznam sledovaných
const { data } = await supabase.from('follows').select('following_id').eq('follower_id', myId);
```

### 4. Storage (voliteľné)

Pre avatary môžete použiť Supabase Storage:
- Vytvorte bucket `avatars`
- Nastavte verejné čítanie
- Upload: `supabase.storage.from('avatars').upload(path, file)`
