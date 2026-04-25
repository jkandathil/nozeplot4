* basic_analog.inc — curated for Circuit Studio (MIT). Compatible .model syntax only.
* Use: .include "basic_analog.inc"

.model D1N914 D(Is=3.4p Rs=0 N=1 EG=1.11 XTI=3 BV=75 Ibv=10u Cjo=1p)
.model SMALLNMOS NMOS(Vto=0.7 Kp=50e-6 Lambda=0.02 Gamma=0 Phi=0.6 L=1u W=10u Cgso=0 Cgdo=0)
.model SMALLPMOS PMOS(Vto=-0.7 Kp=20e-6 Lambda=0.02 Gamma=0 Phi=0.6 L=1u W=20u Cgso=0 Cgdo=0)
