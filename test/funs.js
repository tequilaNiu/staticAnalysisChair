exports.method1 = function() {
  this.service.m1.n1.k1();
}

exports.method2 = () => {
  this.service.m2.n2.k2();
}


const method3 = () => {
  this.service.m3.n3.k3();
};

function method4 () {
  this.service.m4.n4.k4();
}

exports.method5 = function() {
  this.service.m5.n5.k5();
}
