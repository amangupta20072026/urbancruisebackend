Follow these guidelines throughout the design process and when writing code, wherever and whenever applicable.

### S — Single Responsibility Principle

Each module, class, or function should have **one clear responsibility** and, ideally, **one reason to change**.

### O — Open/Closed Principle

Software entities should be **open for extension but closed for modification**. Prefer extending existing behaviour over changing stable, working code.

### L — Liskov Substitution Principle

Subtypes must be **substitutable for their base types** without altering or breaking the expected behaviour of the system.

### I — Interface Segregation Principle

Clients should **not be forced to depend on interfaces they do not use**. Prefer small, focused, role-specific interfaces over large, general-purpose ones.

### D — Dependency Inversion Principle

High-level modules should **not depend directly on low-level modules**. Both should depend on abstractions, with implementation details depending on those abstractions.
