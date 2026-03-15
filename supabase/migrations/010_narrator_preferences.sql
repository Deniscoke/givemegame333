-- Migration 010: Narrator preferences per user
-- Adds persistent narrator style + language columns to profiles table.
-- Run in Supabase SQL Editor after 009_saved_games.sql.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS narrator_styles TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS narrator_lang   TEXT     DEFAULT 'sk';
