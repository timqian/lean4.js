import Lean
open Lean Elab

/-
Spike: import Init ONCE, then elaborate several snippets against the *same*
environment. If each elaborate is ~ms while the import is ~tens of seconds,
the bottleneck is the one-time import, not elaboration → a warm REPL wins.

Everything is inlined into `main`: `lean --run` only IR-compiles `main`, and
we avoid `for`/Array loops (their private unsafe impls aren't interpretable).
-/
def main : IO Unit := do
  let t0 ← IO.monoMsNow
  let env ← importModules #[{ module := `Init }] {} (trustLevel := 1024)
  IO.eprintln s!"[spike] import Init ONCE: {(← IO.monoMsNow) - t0} ms"

  let t1 ← IO.monoMsNow
  let (_, m1) ← Lean.Elab.process "#check 2 + 2" env {} "<spike>"
  IO.eprintln s!"[spike] elaborate #1 (#check 2+2): {(← IO.monoMsNow) - t1} ms ({m1.toList.length} msgs)"

  let t2 ← IO.monoMsNow
  let (_, m2) ← Lean.Elab.process "#check Nat.add" env {} "<spike>"
  IO.eprintln s!"[spike] elaborate #2 (#check Nat.add): {(← IO.monoMsNow) - t2} ms ({m2.toList.length} msgs)"

  let t3 ← IO.monoMsNow
  let (_, m3) ← Lean.Elab.process "#eval 1 + 1" env {} "<spike>"
  IO.eprintln s!"[spike] elaborate #3 (#eval 1+1): {(← IO.monoMsNow) - t3} ms ({m3.toList.length} msgs)"

  let t4 ← IO.monoMsNow
  let (_, m4) ← Lean.Elab.process "def foo := 42" env {} "<spike>"
  IO.eprintln s!"[spike] elaborate #4 (def foo): {(← IO.monoMsNow) - t4} ms ({m4.toList.length} msgs)"
