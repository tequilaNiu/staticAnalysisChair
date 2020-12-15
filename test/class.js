'use strict';

const { xxx } = require('./funs.js');

class AccompanyController extends Controller {
  func1 () {
    const { ctx, service } = this;

    // service
    ctx.service.xx.yy.zz();

    this.ctx.service.mm.nn.qq();

    service.jj.ii.kk();

    this.service.uu.vv();

    (() => {
      service.hh.nn.bb();
    })().sort().compat();


    // fengdie
    this.ctx.fengdie.mmmmm;
    ctx.fengdie.nnnnn;
    xxxx(this.ctx.fengdie.xxxxx);
    xxxx(ctx.fengdie.yyyyy);
    this.fengdie.zzzzz;

    // this
    this.func2();
  }

  async func2 () {
    const { ctx } = this;

    ctx.service.abc.cba();
  }
}
