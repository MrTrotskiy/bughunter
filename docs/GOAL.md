# THE GOAL — what Phase 1 must produce

Read this before changing anything in `lib/recon/`. It is the standing definition of done, restated because
it has had to be explained more than ten times. If a change does not move the crawl toward the state below,
it is not progress, however green its tests are.

## The outcome

**A black box becomes a white box, WITHOUT source access.**

The crawler enters an application knowing nothing. It leaves knowing, for every control: what it is, what
it does, what it accepts, what it refuses, what it sends to the server and what the server answers. Not
"we clicked 300 things" — "we understand 300 things". Source code is a REFERENCE for the operator, never an
input to the crawl. The crawl must be able to produce this on an application it has never seen and whose
code it cannot read.

Progression: **black box → grey box → white box.** Each act moves one control along it.

## The division of labour

**THE SCRIPT IS THE BRAIN. THE AGENT IS THE HANDS.**

- The SCRIPT holds the truth: how many elements exist, which are studied, which are owed, what each one
  still owes, and how much work remains. It decides what happens next and it never loses count.
- The AGENT executes: it goes to the element and works it. It does not decide coverage, does not track
  progress, does not choose the order.
- The loop runs until the script says every element is studied. The script must be able to answer, at any
  moment: **total / studied / outstanding**, and the outstanding number must fall.

Without the script the agent is blind — it will wander, repeat itself, and stop early believing it is done.
That has been measured repeatedly in this project and it is why the script owns the accounting.

## What "studied" means — the child with a ball

A child handed a ball does not learn what it is by touching it once. They squeeze it, bite it, drop it,
throw it, roll it, carry it. Understanding comes from MANY DIFFERENT ACTIONS on ONE object, and specifically
from the actions that FAIL — the ball does not squash, does not tear, does not stay where you put it.

A control is the same. **One touch is not a study.** An element is studied when the crawl has tried the
variations that could distinguish it from every other element, including the ones expected to fail.

### A field
- a valid value — does it accept anything at all
- **empty**, when it declares itself required — does it enforce that
- **over its declared limit** — does it enforce that
- **the wrong shape** for its declared type/pattern/range — letters into a number, text into a date
- what the SERVER said each time, not only what the page said

The negative cases carry more information than the positive one. "It accepts a value" is nearly free;
"it refuses 51 characters but accepts 50" is knowledge.

### A button that opens a form (Create / Add / Save)
Study the FORM, not the button, and study it INCREMENTALLY — this is the sequence:
1. Open it. Submit it EMPTY. What is sent? What comes back? Does the client block it, or does the server?
2. Fill ONE required field. Submit. What changed in the request?
3. Fill the second. Submit. Then the third — one at a time.
4. Then invalid values in each field, one at a time.

Each submit is a different question. Submitting a fully-filled form once answers only the happy path and
teaches nothing about which field is actually required, which is validated where, and what the server does
when it is lied to.

### A table
A table is an object to be studied, not a row to be sampled.
- what are its columns, how many rows, where does its DATA come from (which endpoint)
- is a row clickable, and where does it lead
- what actions live in a row, and do different rows behave differently
- sorting, filtering, paging — each is its own control
Rows are sampled at the BOUNDARIES (first, middle, last) and the sample WIDENS when rows disagree, because
"fifty rows are one control" is an assumption that has already been measured false.

## Anomalies are findings, not noise

A `403` or `500` where `200` belongs is not a failed probe to retry away — it is the most valuable thing
the crawl can find, and it must be recorded, attributed to the act that caused it, and reported. Same for:
a form that accepts an empty required field, a field that declares a limit it does not enforce, a control
that silently does nothing. The crawl exists to find these.

## The finish line

Phase 1 is done for an element when the script's list of obligations for it is empty — every probe its
declarations call for has been asked and ANSWERED, or is honestly recorded as unanswerable with a reason.
Phase 1 is done for an application when that holds for every element, and the outstanding count is zero
with nothing hidden in an uncounted bucket.

## What this rules out

- Reporting coverage as "clicked" — clicking is effort, not knowledge.
- Declaring an element done after one act.
- Skipping a control class (tables, rows, fields behind modals) because it is awkward to reach.
- A number that rises while the outstanding list is untouched.
- Trusting the agent to remember what is left. That is the script's job.
