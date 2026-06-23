# HomeJob - Cloudflare

## Cloudflare Pages

Ustawienia projektu Pages:

- Framework preset: `None`
- Build command: puste
- Build output directory: `.`

## Cloudflare D1

1. W Cloudflare wejdz do `Storage & Databases` -> `D1 SQL Database`.
2. Uzyj obecnej bazy `home` albo utworz nowa baze.
3. W zakladce `Console` wykonaj zawartosc pliku `schema.sql`.
4. W projekcie Pages wejdz w `Settings` -> `Bindings`.
5. Dodaj albo sprawdz binding typu `D1 database`.
6. Nazwa zmiennej/bindingu musi byc dokladnie `DB`.
7. Wybierz baze.
8. Zapisz ustawienia i zrob ponowny deploy projektu.

## Web Push

1. Jesli masz juz domy i zadania, w D1 wykonaj tylko plik `push-schema.sql`.
2. Plik `push-schema.sql` dodaje tabele do powiadomien i nie usuwa danych.
3. W katalogu `workers/` jest osobny Worker `homejob-reminders`.
4. Worker musi miec binding D1 o nazwie `DB` do tej samej bazy.
5. Worker musi miec cron `* * * * *`.
6. Worker musi miec sekret `VAPID_PRIVATE_KEY`.
7. Wartosci sekretu nie wrzucaj do GitHuba. Jest w pliku `outputs/homejob-vapid-private-key-v25.txt`.

### Worker przypomnien przez panel Cloudflare

1. Wejdz w `Workers & Pages` -> `Create application` -> `Start with Hello World!`.
2. Nazwij Workera `homejob-reminders`.
3. Wejdz w edycje kodu Workera i wklej zawartosc `workers/push-reminders.js`.
4. W ustawieniach Workera dodaj binding `D1 database`:
   - Variable name: `DB`
   - Database: ta sama baza, ktorej uzywa Pages.
5. W `Variables and Secrets` dodaj:
   - `VAPID_PUBLIC_KEY` jako zwykla zmienna z wartoscia z `workers/wrangler.toml`
   - `VAPID_PRIVATE_KEY` jako sekret z pliku `outputs/homejob-vapid-private-key-v25.txt`
   - opcjonalnie `VAPID_SUBJECT`, np. `mailto:twoj-email@example.com`
6. W `Triggers` -> `Cron Triggers` dodaj `* * * * *`.
7. Zapisz i zrob deploy Workera.

Na iPhonie dodaj HomeJob do ekranu poczatkowego, otworz z ikony i kliknij `Powiadomienia`.

## Model danych

Kazdy dom jest osobnym rekordem w tabeli `households`. Aplikacja pobiera dom tylko po podaniu poprawnego PIN-u domownika.

PIN-y nie sa juz ustawiane jako sekrety Cloudflare. Sa tworzone razem z domownikami przy zakladaniu domu i zapisywane w rekordzie danego domu.

## Reset bazy

Plik `schema.sql` czysci stare tabele `app_state` i `households`, a potem tworzy pusta tabele `households`. Uzyj go tylko wtedy, gdy chcesz wyczyscic dane i zaczac od zera.

Plik `push-schema.sql` jest bezpieczna migracja dla powiadomien. Nie kasuje domow, zadan ani historii.
