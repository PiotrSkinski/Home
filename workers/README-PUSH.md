# HomeJob push reminders

Ten Worker wysyła prawdziwe Web Push:

- codziennie o 08:00 plan zadań na dziś dla każdego domownika — razem z listą zaległości,
- o godzinie przypomnienia ustawionej w konkretnym zadaniu (tylko zadania z dzisiejszym terminem),
- wieczorem od 22:00, jeśli domownik ma niewykonane zadania z dzisiaj,
- od razu po złożeniu wniosku o przełożenie lub „nie ma potrzeby” oraz po decyzji domu.

Zaległe zadania nie wysyłają już osobnych przypomnień co dzień o swojej godzinie — idą zbiorczo w porannym przeglądzie. Zadanie, nad którym trwa głosowanie, milczy do czasu decyzji.

Cron działa co minutę, a kod przelicza czas na strefę `Europe/Warsaw`. Powiadomienia mają okna czasowe, więc krótkie opóźnienie crona nie powinno zgubić przypomnienia.

## Konfiguracja

1. W D1 uruchom plik `push-schema.sql` z głównego katalogu aplikacji. Na istniejącej bazie ostatnia linia (`ALTER TABLE push_messages ADD COLUMN attempts ...`) może zgłosić „duplicate column name” — to normalne, można zignorować.
2. W `wrangler.toml` ustaw prawdziwe `database_id` swojej bazy D1.
3. W Cloudflare ustaw sekret Workera:

   `VAPID_PRIVATE_KEY`

4. Wartość sekretu jest w pliku wygenerowanym obok paczek ZIP:

   `outputs/homejob-vapid-private-key-v25.txt`

5. Wdróż Workera `homejob-reminders`.

Na iPhonie HomeJob musi być dodany do ekranu początkowego. Potem w aplikacji kliknij `Powiadomienia`.
