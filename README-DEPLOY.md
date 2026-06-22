# Domowe zadania - Cloudflare

## GitHub Pages/Cloudflare Pages

Ustawienia projektu Pages:

- Framework preset: `None`
- Build command: puste
- Build output directory: `.`

## Cloudflare D1

1. W Cloudflare wejdz do `Storage & Databases` -> `D1 SQL Database`.
2. Utworz baze o nazwie `domowe_zadania`.
3. W zakladce `Console` wykonaj zawartosc pliku `schema.sql`.
4. W projekcie Pages wejdz w `Settings` -> `Bindings`.
5. Dodaj binding typu `D1 database`.
6. Nazwa zmiennej/bindingu musi byc dokladnie `DB`.
7. Wybierz baze `domowe_zadania`.
8. Zapisz ustawienia i zrob ponowny deploy projektu.

Endpoint `/api/state` bedzie zapisywal wspolny stan aplikacji w D1.

## PIN-y i sekrety

W projekcie Pages wejdz w `Settings` -> `Variables and Secrets` i dodaj sekrety:

- `PIOTR_PIN` - PIN Piotra
- `MARTA_PIN` - PIN Marty

Opcjonalnie mozna dodac tez `HOUSEHOLD_PIN` jako wspolny PIN awaryjny dla domu.

Po dodaniu sekretow zrob ponowny deploy. Endpoint `/api/state` bedzie odrzucal requesty bez poprawnego PIN-u.
