// Option structure names for the Builder, the Strategies screen's deploy panel and the saved trades: what a set of
// legs is (iron condor, bull put spread, call ratio, …), whether it takes in a credit and which side is naked.
(() => {
  const isShort = (l) => l.action === 'S';

  // ---------- structure ----------
  function structure(legs) {
    const sc = legs.filter((l) => isShort(l) && l.type === 'CE');
    const sp = legs.filter((l) => isShort(l) && l.type === 'PE');
    const lc = legs.filter((l) => !isShort(l) && l.type === 'CE');
    const lp = legs.filter((l) => !isShort(l) && l.type === 'PE');
    const lots = (a) => a.reduce((s, l) => s + l.lots, 0);
    const n = legs.length;
    let name = 'custom';
    if (!n) name = 'none';
    else if (sc.length === 1 && sp.length === 1 && !lc.length && !lp.length) name = sc[0].strike === sp[0].strike ? 'short straddle' : 'short strangle';
    else if (sc.length === 1 && sp.length === 1 && lc.length === 1 && lp.length === 1) name = sc[0].strike === sp[0].strike ? 'iron fly' : 'iron condor';
    else if (lc.length === 1 && lp.length === 1 && !sc.length && !sp.length) name = lc[0].strike === lp[0].strike ? 'long straddle' : 'long strangle';
    else if (sp.length === 1 && lp.length === 1 && !sc.length && !lc.length) name = sp[0].strike > lp[0].strike ? 'bull put spread' : 'put debit spread';
    else if (sc.length === 1 && lc.length === 1 && !sp.length && !lp.length) name = sc[0].strike < lc[0].strike ? 'bear call spread' : 'bull call spread';
    else if (n === 1) name = (isShort(legs[0]) ? 'naked short ' : 'long ') + (legs[0].type === 'CE' ? 'call' : 'put');
    else if (sc.length && lc.length && lots(sc) > lots(lc) && !sp.length && !lp.length) name = 'call ratio';
    else if (sp.length && lp.length && lots(sp) > lots(lp) && !sc.length && !lc.length) name = 'put ratio';
    else if (lc.length === 2 && sc.length === 1 && lots(sc) === 2 && !sp.length && !lp.length) name = 'call butterfly';
    else if (lp.length === 2 && sp.length === 1 && lots(sp) === 2 && !sc.length && !lc.length) name = 'put butterfly';
    const credit = [
      'short straddle',
      'short strangle',
      'iron fly',
      'iron condor',
      'bull put spread',
      'bear call spread',
      'naked short call',
      'naked short put',
      'call ratio',
      'put ratio',
    ].includes(name);
    return { name, sc, sp, lc, lp, credit, nakedCalls: lots(sc) > lots(lc), nakedPuts: lots(sp) > lots(lp) };
  }

  window.SBAdjust = { structure };
})();
