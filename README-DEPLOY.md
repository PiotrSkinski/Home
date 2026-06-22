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

## Model danych

Kazdy dom jest osobnym rekordem w tabeli `households`. Aplikacja pobiera dom tylko po podaniu poprawnego PIN-u domownika.

PIN-y nie sa juz ustawiane jako sekrety Cloudflare. Sa tworzone razem z domownikami przy zakladaniu domu i zapisywane w rekordzie danego domu.

## Reset bazy

Plik `schema.sql` czysci stare tabele `app_state` i `households`, a potem tworzy pusta tabele `households`. Uzyj go tylko wtedy, gdy chcesz wyczyscic dane i zaczac od zera.
