# Security Specification for Event Registrations

## 1. Data Invariants
- Only valid registrations with required fields (`name`, `email`, `status`, `createdAt`) can be created.
- `name` must be a string between 1 and 50 characters.
- `email` must be a string between 5 and 100 characters.
- `phone` must be a string under 30 characters if present.
- `job` must be a string under 50 characters if present.
- `question` must be a string under 500 characters if present.
- `status` must be one of `['pending', 'confirmed', 'cancelled']`.
- Only verified organizer / admin users (including bootstrapped admin `nolaeng3@gmail.com`) can read, update, or delete registrations to protect applicant PII.
- Path variables must be valid document IDs conforming to `^[a-zA-Z0-9_\\-]+$` up to 128 characters.

## 2. Dirty Dozen Payloads (Designed to Fail)
1. Missing email field on create
2. Email exceeds 100 characters
3. Name is empty string
4. Name exceeds 50 characters
5. Unwhitelisted field injected (e.g. `role: 'admin'`)
6. Invalid status value (e.g. `status: 'superadmin'`)
7. Status set to number instead of string
8. Document ID contains illegal special characters (`/`, `..`)
9. Non-admin attempting to read registration document
10. Non-admin attempting to list all registrations
11. Non-admin attempting to delete a registration
12. Attempt to update registration without valid fields or schema mismatch
