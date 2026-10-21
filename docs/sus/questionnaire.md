# Usability study — System Usability Scale (SUS)

The SUS is a ten-item questionnaire with a 1–5 agreement scale (Brooke, 1996).
It is short, validated across thousands of studies, and produces a single
0–100 score that can be compared with published norms. Only the word
"system" is changed here, to name what participants used.

## Who and how many

A pilot class of **at least 12 students**; the SUS is reliable from around 12
respondents. More is better — aim for a full section.

## Session plan (about 15 minutes per student, run as a class)

1. **Consent (1 min).** Read the note below. Participation is voluntary and
   anonymous; nothing about the participant is recorded beyond their answers.
2. **Tasks (8 min).** On their own phones, students do the following, unaided:
   - open the student app link and register the phone;
   - enrol in the course;
   - mark attendance when the faculty projects the code;
   - find their mark under *Recent*.
   The facilitator only notes where anyone gets stuck — never helps.
3. **Questionnaire (3 min).** Immediately afterwards, the ten items below.
4. **Optional (3 min).** One open question: *What was the most confusing moment?*

## Consent note

> This is a study of how easy the attendance app is to use. It is not a test
> of you. Your answers are anonymous and are used only in our project report.
> You can stop at any point without giving a reason.

## The ten items

Each answered on a scale of **1 = Strongly disagree** to **5 = Strongly agree**.
Do not reorder or reword them: the scoring depends on odd items being positive
and even items negative.

1. I think that I would like to use the Haazir app frequently.
2. I found the Haazir app unnecessarily complex.
3. I thought the Haazir app was easy to use.
4. I think that I would need the support of a technical person to be able to use the Haazir app.
5. I found the various functions in the Haazir app were well integrated.
6. I thought there was too much inconsistency in the Haazir app.
7. I would imagine that most people would learn to use the Haazir app very quickly.
8. I found the Haazir app very cumbersome to use.
9. I felt very confident using the Haazir app.
10. I needed to learn a lot of things before I could get going with the Haazir app.

## As a Google Form

Ten *Linear scale* questions, 1 to 5, labelled *Strongly disagree* and
*Strongly agree*, all required, in this order. Do not collect email addresses.
After the session, export the responses (*Responses → Download CSV*) and paste
the ten answer columns into `sus-scoring.xlsx`, sheet **Responses**, columns
B to K. The score, validity check and summary fill in by themselves.

## Reading the result

| SUS score | Interpretation |
|---|---|
| 80.3 and above | Grade A — top 10% of products measured |
| 68 to 80.2 | Above average |
| 51 to 67.9 | Below average |
| below 51 | Poor — bottom 15% |

68 is the average across published studies (Sauro, 2011). Report the mean with
its 95% confidence interval and the number of respondents; the workbook
computes all three.

## References

Brooke, J. (1996). SUS: A "quick and dirty" usability scale. In P. W. Jordan,
B. Thomas, B. A. Weerdmeester, & I. L. McClelland (Eds.), *Usability evaluation
in industry* (pp. 189–194). Taylor & Francis.

Sauro, J. (2011). *A practical guide to the System Usability Scale: Background,
benchmarks & best practices*. Measuring Usability LLC.
