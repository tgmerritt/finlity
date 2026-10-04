# Akahu fixtures

Synthetic. Written by hand on 2026-10-05 from Akahu's public documentation
(no request was made to Akahu, and no real token exists in this repository):

- https://developers.akahu.nz/docs/accessing-account-data
- https://developers.akahu.nz/docs/the-account-model
- https://developers.akahu.nz/docs/accessing-transactional-data
- https://developers.akahu.nz/reference/get_transactions

Every id, name and institution is made up (`acc_example...`, `Example ...`).

- `accounts.json`: `GET /v1/accounts`, one account of each mapped type plus a
  KIWISAVER account (maps to `unknown`). A negative credit card or loan
  `balance.current` is the amount owed, as the account model page states.
- `transactions_page1.json` and `transactions_page2.json`: `GET /v1/transactions`,
  oldest first, with `cursor.next` set on page 1 and null on page 2. Page 1
  has a row for an account a sync might not request.
- `inactive.json`: `GET /v1/accounts` where one account is `INACTIVE`.
